import { setInterval, clearInterval } from "node:timers";

import { SESSION_IDLE_TIMEOUT_MS, SESSION_SWEEP_INTERVAL_MS } from "@/_defs";
import { $logger } from "@/_libs";
import type { WslExecResult, WslHostProfile, WslSessionInfo } from "@/_types";
import { inspectWorkingDirectory } from "@/modules/guard";

import { WslHost } from "./wsl-host";

/** Ceiling on open sessions — a runaway loop must not grow the map without bound. */
const MAX_OPEN_SESSIONS = 32;

/**
 * Shell state carried across commands — the working directory. Nothing else persists:
 * each command is its own `wsl.exe` process, so the session is the memory, not a channel.
 */
export class WslSession {
    /** Empty until the first command reports `$PWD`; then the real distro path. */
    cwd: string;
    lastUsedAt: Date;
    execCount = 0;

    readonly openedAt = new Date();

    /** Tail of the serialized operation chain; see `runExclusive`. */
    private operationChain: Promise<unknown> = Promise.resolve();
    private activeOperationCount = 0;

    constructor(
        public readonly sessionId: string,
        public readonly host: WslHost
    ) {
        this.cwd = host.profile.defaultCwd ?? "";
        this.lastUsedAt = new Date();
    }

    get profile(): WslHostProfile {
        return this.host.profile;
    }

    /** True while an operation is running, so the idle sweeper leaves it alone. */
    get isBusy(): boolean {
        return this.activeOperationCount > 0;
    }

    touch(): void {
        this.lastUsedAt = new Date();
    }

    /**
     * Runs `operation` with exclusive use of this session.
     *
     * Serialized because `cwd` is read-modify-write across a process run: two concurrent
     * calls both read the old directory, and the one that finishes second writes it back —
     * silently undoing the other's `cd`.
     */
    async runExclusive<T>(operation: (host: WslHost) => Promise<T>): Promise<T> {
        const previous = this.operationChain;

        let releaseChain: () => void = () => {
            // Replaced below; assigned here so the type is not nullable.
        };
        this.operationChain = new Promise<void>((resolve) => {
            releaseChain = resolve;
        });

        await previous.catch(() => {
            // A failed predecessor must not poison the queue for later callers.
        });

        this.activeOperationCount += 1;
        this.touch();

        try {
            return await operation(this.host);
        }
        finally {
            this.activeOperationCount -= 1;
            this.touch();
            releaseChain();
        }
    }

    /**
     * Runs a command in this session's working directory and adopts wherever it ended up,
     * so a `cd` in one call is still in effect on the next.
     *
     * Passing `cwd` runs this command elsewhere *and* moves the session there — same
     * result as prefixing `cd <cwd> &&`, which is what a shell user would expect.
     */
    async exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<WslExecResult> {
        const policy = this.profile.policy;
        const targetCwd = options?.cwd ?? this.cwd;

        return await this.runExclusive(async (host) => {
            const result = await host.exec({
                command: command,
                cwd: targetCwd,
                timeoutMs: options?.timeoutMs ?? policy.execTimeoutMs,
                maxOutputCharacters: policy.maxOutputCharacters,
                trackCwd: true,
            });

            if (result.cwd != null && result.cwd !== "") {
                // The reported `$PWD` becomes the `cd` argument of the next command, so it
                // goes through the same metacharacter check as a caller-supplied cwd.
                const verdict = inspectWorkingDirectory(result.cwd);
                if (verdict.allowed == true) {
                    this.cwd = result.cwd;
                }
                else {
                    const _logger = $logger.child({ context: "WslSession.exec", session_id: this.sessionId });
                    _logger.warn("reported working directory contains unsafe characters, keeping the previous cwd", {
                        reported_cwd: result.cwd,
                    });
                }
            }

            this.execCount += 1;
            return result;
        });
    }

    toInfo(): WslSessionInfo {
        let displayCwd = this.cwd;
        if (displayCwd === "") {
            displayCwd = "(login default)";
        }

        return {
            sessionId: this.sessionId,
            profileName: this.profile.name,
            distro: this.profile.distro,
            username: this.profile.username ?? "(distro default)",
            cwd: displayCwd,
            openedAt: this.openedAt.toISOString(),
            lastUsedAt: this.lastUsedAt.toISOString(),
            execCount: this.execCount,
        };
    }
}

/** Owns every open session: creation, lookup, idle expiry and shutdown. */
export class WslSessionManager {
    private readonly sessions = new Map<string, WslSession>();
    private sequence = 0;
    private sweepTimer: NodeJS.Timeout | null = null;

    /**
     * Registers a session. Nothing is opened — the caller probes with `pwd` to prove
     * the distro answers and to settle the starting directory.
     *
     * @throws {Error} If the session ceiling is reached.
     */
    open(host: WslHost): WslSession {
        if (this.sessions.size >= MAX_OPEN_SESSIONS) {
            throw new Error(`too many open wsl sessions (${MAX_OPEN_SESSIONS}), close some with wsl_disconnect first`);
        }

        this.sequence += 1;
        const sessionId = `${host.profile.name}#${this.sequence}`;

        const session = new WslSession(sessionId, host);
        this.sessions.set(sessionId, session);

        const _logger = $logger.child({ context: "WslSessionManager.open", session_id: sessionId, profile: host.profile.name });
        _logger.info("wsl session opened", { open_sessions: this.sessions.size });

        return session;
    }

    /**
     * Looks up a session, failing with the list of live ids so the caller can self-correct.
     *
     * @throws {Error} If no session matches `sessionId`.
     */
    require(sessionId: string): WslSession {
        const session = this.sessions.get(sessionId);
        if (session == null) {
            const openIds = Array.from(this.sessions.keys());

            let openSummary = "none";
            if (openIds.length > 0) {
                openSummary = openIds.join(", ");
            }

            throw new Error(`unknown wsl session '${sessionId}' (open sessions: ${openSummary})`);
        }

        return session;
    }

    close(sessionId: string): boolean {
        const deleted = this.sessions.delete(sessionId);
        if (deleted == false) {
            return false;
        }

        const _logger = $logger.child({ context: "WslSessionManager.close", session_id: sessionId });
        _logger.info("wsl session closed", { open_sessions: this.sessions.size });

        return true;
    }

    closeAll(): void {
        for (const sessionId of Array.from(this.sessions.keys())) {
            this.close(sessionId);
        }
    }

    list(): WslSessionInfo[] {
        return Array.from(this.sessions.values()).map((session) => session.toInfo());
    }

    /** Starts the idle sweeper; the timer is unref'd so it never holds the process open. */
    startIdleSweeper(): void {
        if (this.sweepTimer != null) {
            return;
        }

        this.sweepTimer = setInterval(() => {
            const expiredAt = Date.now() - SESSION_IDLE_TIMEOUT_MS;
            for (const session of Array.from(this.sessions.values())) {
                if (session.isBusy == true) {
                    continue;
                }

                if (session.lastUsedAt.getTime() > expiredAt) {
                    continue;
                }

                const _logger = $logger.child({
                    context: "WslSessionManager.sweep",
                    session_id: session.sessionId,
                    idle_ms: Date.now() - session.lastUsedAt.getTime(),
                });
                _logger.info("forgetting idle wsl session");
                this.close(session.sessionId);
            }
        }, SESSION_SWEEP_INTERVAL_MS);

        this.sweepTimer.unref();
    }

    stopIdleSweeper(): void {
        if (this.sweepTimer == null) {
            return;
        }

        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
    }
}
