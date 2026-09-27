import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { MAX_CONCURRENT_PROCESSES, OUTPUT_HARD_CAP_MULTIPLIER, WSL_EXECUTABLE, WSL_FAILURE_EXIT_CODES } from "@/_defs";
import { $logger, truncateOutput } from "@/_libs";
import type { WslExecResult, WslHostProfile } from "@/_types";
import { GuardRejectionError, canonicalizeCommand, inspectWorkingDirectory, inspectWslCommand } from "@/modules/guard";

import { buildDistroScript, buildWslArguments, extractCwdMarker } from "./wsl-command";

export interface WslExecOptions {
    command: string;
    /** Directory to `cd` into first; the login shell's default is used when absent. */
    cwd?: string;
    timeoutMs: number;
    maxOutputCharacters: number;
    /** Appends a `$PWD` marker so a session can follow `cd` between commands. */
    trackCwd: boolean;
}

/** A fixed script run without the command guard — the file operations, whose only variable part is a quoted path. */
export interface WslProcessOptions {
    script: string;
    /** Fed to the process and then closed; absent means stdin is closed from the start. */
    stdin?: Buffer | Readable;
    /** When set, stdout streams here instead of being buffered, and `stdout` comes back empty. */
    stdoutSink?: Writable;
    timeoutMs: number;
    /** Bytes buffered per stream before the process is killed. */
    maxCapturedBytes: number;
}

export interface WslProcessOutput {
    stdout: Buffer;
    stderr: Buffer;
    /** Bytes that went to `stdoutSink`, when one was given. */
    sinkBytes: number;
    exitCode: number | null;
    signal?: string;
    timedOut: boolean;
    capExceeded: boolean;
    durationMs: number;
}

let activeProcessCount = 0;

/**
 * One distro + user, plus the operations run in it. Every call is its own `wsl.exe`
 * process; nothing is held between calls.
 *
 * This class is the chokepoint: it holds the profile, so it applies the command guard
 * itself rather than trusting each caller to remember — the same reasoning as
 * `SshConnection` in `@akms/mcp-ssh`.
 */
export class WslHost {
    constructor(public readonly profile: WslHostProfile) {
    }

    /**
     * Screens a command against this profile's policy, then runs it.
     *
     * The canonical form is what gets screened *and* what gets sent — validating one
     * string while executing another is a bypass by construction.
     *
     * @throws {GuardRejectionError} If the policy refuses the command or the cwd.
     * @throws {Error} If `wsl.exe` itself fails (unknown distro, service down) or cannot be spawned.
     */
    async exec(options: WslExecOptions): Promise<WslExecResult> {
        const canonicalCommand = canonicalizeCommand(options.command);

        const verdict = inspectWslCommand(canonicalCommand, this.profile);
        if (verdict.allowed == false) {
            throw new GuardRejectionError(verdict);
        }

        if (options.cwd != null) {
            const cwdVerdict = inspectWorkingDirectory(options.cwd);
            if (cwdVerdict.allowed == false) {
                throw new GuardRejectionError(cwdVerdict);
            }
        }

        const _logger = $logger.child({ context: "WslHost.exec", profile: this.profile.name, cwd: options.cwd });

        const script = buildDistroScript(canonicalCommand, options.cwd, options.trackCwd);
        const raw = await this.runProcess({
            script: script,
            timeoutMs: options.timeoutMs,
            maxCapturedBytes: options.maxOutputCharacters * OUTPUT_HARD_CAP_MULTIPLIER,
        });

        // Only parse the marker when this call asked for it — otherwise output that merely
        // contains the marker text would be silently cut at that point.
        let output = raw.stdout.toString("utf8");
        let cwd: string | undefined = undefined;
        if (options.trackCwd == true) {
            const parsed = extractCwdMarker(output);
            output = parsed.output;
            cwd = parsed.cwd;
        }

        const truncatedStdout = truncateOutput(output, options.maxOutputCharacters);
        const truncatedStderr = truncateOutput(raw.stderr.toString("utf8"), options.maxOutputCharacters);

        const result: WslExecResult = {
            stdout: truncatedStdout.text,
            stderr: truncatedStderr.text,
            exitCode: raw.exitCode,
            timedOut: raw.timedOut,
            truncated: truncatedStdout.truncated == true || truncatedStderr.truncated == true || raw.capExceeded == true,
            durationMs: raw.durationMs,
        };

        if (raw.signal != null) {
            result.signal = raw.signal;
        }

        if (cwd != null) {
            result.cwd = cwd;
        }

        _logger.debug("command finished", {
            exit_code: result.exitCode,
            duration_ms: result.durationMs,
            timed_out: result.timedOut,
            truncated: result.truncated,
        });

        return result;
    }

    /**
     * Spawns `wsl.exe` for one script and collects what it produced.
     *
     * Not guarded — callers own that: `exec` screens the command, the file operations
     * screen the path and build the script themselves. stdin is closed (or fed and then
     * closed) so anything that waits for input fails at once instead of hanging until the
     * timeout.
     *
     * @throws {Error} If the process ceiling is reached, `wsl.exe` cannot be started, or
     *                 `wsl.exe` reports a failure of its own rather than the command's exit
     *                 status — that message (unknown distro, service down) is the whole diagnosis.
     */
    async runProcess(options: WslProcessOptions): Promise<WslProcessOutput> {
        if (activeProcessCount >= MAX_CONCURRENT_PROCESSES) {
            throw new Error(`too many concurrent wsl.exe processes (${MAX_CONCURRENT_PROCESSES}); wait for running calls to finish`);
        }

        const _logger = $logger.child({ context: "WslHost.runProcess", profile: this.profile.name });
        const wslArguments = buildWslArguments(this.profile, options.script);
        const startedAt = Date.now();

        activeProcessCount += 1;
        try {
            const raw = await new Promise<WslProcessOutput>((resolve, reject) => {
                let stdinMode: "ignore" | "pipe" = "ignore";
                if (options.stdin != null) {
                    stdinMode = "pipe";
                }

                const child = spawn(WSL_EXECUTABLE, wslArguments, {
                    // WSL_UTF8: wsl.exe's *own* messages (unknown distro, service errors) are
                    // UTF-16 by default even on a pipe; the Linux side is UTF-8 regardless.
                    env: { ...process.env, WSL_UTF8: "1" },
                    stdio: [stdinMode, "pipe", "pipe"],
                    windowsHide: true,
                });

                // Typed nullable for the 'ignore' / 'inherit' cases; both are pipes here.
                const stdoutStream = child.stdout;
                const stderrStream = child.stderr;
                if (stdoutStream == null || stderrStream == null) {
                    reject(new Error("wsl.exe was spawned without stdio pipes"));
                    return;
                }

                const stdoutChunks: Buffer[] = [];
                const stderrChunks: Buffer[] = [];
                let stdoutBytes = 0;
                let stderrBytes = 0;
                let sinkBytes = 0;
                let timedOut = false;
                let capExceeded = false;
                let settled = false;
                // A local read error mid-upload: the distro-side `cat` would see a clean
                // EOF and exit 0, reporting a truncated upload as success.
                let stdinFailure: Error | null = null;

                const timeoutTimer = setTimeout(() => {
                    timedOut = true;
                    _logger.warn("command timed out, killing wsl.exe", { timeout_ms: options.timeoutMs });
                    child.kill();
                }, options.timeoutMs);
                timeoutTimer.unref();

                const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
                    if (settled == true) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timeoutTimer);

                    const output: WslProcessOutput = {
                        stdout: Buffer.concat(stdoutChunks),
                        stderr: Buffer.concat(stderrChunks),
                        sinkBytes: sinkBytes,
                        exitCode: exitCode,
                        timedOut: timedOut,
                        capExceeded: capExceeded,
                        durationMs: Date.now() - startedAt,
                    };
                    if (signal != null) {
                        output.signal = signal;
                    }

                    resolve(output);
                };

                const fail = (error: Error): void => {
                    if (settled == true) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timeoutTimer);
                    reject(error);
                };

                // Latch: packets keep arriving after the cap trips and kill() is asynchronous.
                const exceedCap = (stream: string): void => {
                    if (capExceeded == true) {
                        return;
                    }
                    capExceeded = true;
                    _logger.warn(`${stream} exceeded the hard cap, killing wsl.exe`, { hard_cap: options.maxCapturedBytes });
                    child.kill();
                };

                if (options.stdoutSink != null) {
                    const sink = options.stdoutSink;
                    stdoutStream.on("data", (chunk: Buffer) => {
                        sinkBytes += chunk.length;
                    });
                    stdoutStream.pipe(sink, { end: false });
                    sink.on("error", fail);
                }
                else {
                    stdoutStream.on("data", (chunk: Buffer) => {
                        if (capExceeded == true) {
                            return;
                        }
                        stdoutChunks.push(chunk);
                        stdoutBytes += chunk.length;
                        if (stdoutBytes > options.maxCapturedBytes) {
                            exceedCap("stdout");
                        }
                    });
                }

                stderrStream.on("data", (chunk: Buffer) => {
                    if (capExceeded == true) {
                        return;
                    }
                    stderrChunks.push(chunk);
                    stderrBytes += chunk.length;
                    if (stderrBytes > options.maxCapturedBytes) {
                        exceedCap("stderr");
                    }
                });

                child.on("error", fail);
                // 'close' rather than 'exit': the stdio streams are drained by then.
                child.on("close", (exitCode, signal) => {
                    if (stdinFailure != null) {
                        fail(new Error(`local input failed while feeding the distro: ${stdinFailure.message}`));
                        return;
                    }
                    finish(exitCode, signal);
                });

                if (options.stdin != null && child.stdin != null) {
                    // A process that exits before reading everything (a guard-free `head`,
                    // a failing `cat`) makes the pipe error with EPIPE; that is not a failure
                    // of the operation, whose exit code and stderr say what happened.
                    child.stdin.on("error", () => {
                        // intentionally ignored
                    });

                    if (Buffer.isBuffer(options.stdin) == true) {
                        child.stdin.end(options.stdin);
                    }
                    else {
                        const source = options.stdin as Readable;
                        source.on("error", (error: Error) => {
                            stdinFailure = error;
                            child.kill();
                        });
                        source.pipe(child.stdin);
                    }
                }
            });

            // wsl.exe's own failure comes back as an exit status the command could never
            // produce, with the reason on stdout (Windows-localised). Surface it as an error
            // rather than an "exit code 4294967295" that the model would misread.
            if (raw.exitCode != null && WSL_FAILURE_EXIT_CODES.includes(raw.exitCode) == true) {
                let detail = `${raw.stdout.toString("utf8")}\n${raw.stderr.toString("utf8")}`.trim();
                if (detail === "" && options.stdoutSink != null) {
                    // The reason went down the sink with the rest of stdout.
                    detail = "wsl.exe reported a failure of its own (unknown distro, WSL service down) — run akms-mcp-wsl --check";
                }
                throw new Error(`wsl.exe failed for distro '${this.profile.distro}': ${detail}`);
            }

            return raw;
        }
        finally {
            activeProcessCount -= 1;
        }
    }
}
