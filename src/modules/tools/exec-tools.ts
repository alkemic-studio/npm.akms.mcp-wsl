import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { $logger } from "@/_libs";
import type { WslExecResult } from "@/_types";

import { formatExecResult } from "./format";
import { resolveHost, textResult, toToolError } from "./tool-context";
import type { ToolContext } from "./tool-context";

export function registerExecTools(server: McpServer, context: ToolContext): void {
    server.registerTool(
        "wsl_exec",
        {
            title: "Run a command in WSL",
            description: [
                "Run a shell command in the configured WSL distro (as the configured user, in a login bash) and return stdout, stderr and the exit code.",
                "Pass 'session' to reuse a session, which remembers its working directory; omit it for a one-off call.",
                "A non-zero exit code is reported as normal output, not as a tool error — read the exit code and stderr to judge the outcome.",
                "Almost everything is permitted: package installs, service restarts, sudo, interpreters. Refused outright: catastrophic operations (wiping the filesystem root, formatting a disk, powering off or shutting down the distro), and — unless the profile opens them — Windows interop executables and writes under /mnt/<drive>/.",
                "stdin is closed. A job that must outlive the call needs all three descriptors detached: nohup cmd > log 2>&1 < /dev/null &",
            ].join(" "),
            inputSchema: {
                command: z.string().min(1).describe("Shell command, exactly as it would be typed in a terminal. Chaining with ';', '&&', '||' and pipes is allowed; each part is screened separately."),
                session: z.string().optional().describe("Session id from wsl_connect. Keeps the working directory across calls."),
                cwd: z.string().optional().describe("Absolute directory to run in, with no shell metacharacters. With a session, the session also moves there."),
                timeoutMs: z.number().int().positive().optional().describe("Lowers the command timeout for this call; it cannot exceed the profile's own limit. wsl.exe is killed when it elapses; the process inside the distro may survive."),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ command, session, cwd, timeoutMs }) => {
            let _logger = $logger.child({ context: "wsl_exec" });

            try {
                const { host, session: openSession } = resolveHost(context, { session: session });
                const profile = host.profile;
                _logger = _logger.child({ profile: profile.name, session_id: openSession?.sessionId });

                // Clamped, not defaulted: a per-call override that could exceed the profile
                // ceiling would make the ceiling advisory.
                const requestedTimeoutMs = timeoutMs ?? profile.policy.execTimeoutMs;
                const effectiveTimeoutMs = Math.min(requestedTimeoutMs, profile.policy.execTimeoutMs);

                // An empty string is "not specified", not "the root of nowhere" — passing it
                // through would silently reset a session's tracked directory.
                let requestedCwd: string | undefined = undefined;
                if (cwd != null && cwd.trim() !== "") {
                    requestedCwd = cwd.trim();
                }

                _logger.debug("running command", { command: command, timeout_ms: effectiveTimeoutMs });

                let result: WslExecResult;
                if (openSession != null) {
                    result = await openSession.exec(command, { cwd: requestedCwd, timeoutMs: effectiveTimeoutMs });
                }
                else {
                    result = await host.exec({
                        command: command,
                        cwd: requestedCwd ?? profile.defaultCwd,
                        timeoutMs: effectiveTimeoutMs,
                        maxOutputCharacters: profile.policy.maxOutputCharacters,
                        trackCwd: false,
                    });
                }

                _logger.info("command finished", {
                    exit_code: result.exitCode,
                    duration_ms: result.durationMs,
                    timed_out: result.timedOut,
                });
                return textResult(formatExecResult(result, effectiveTimeoutMs));
            }
            catch (ex) {
                return toToolError(ex, "wsl_exec", command);
            }
        }
    );
}
