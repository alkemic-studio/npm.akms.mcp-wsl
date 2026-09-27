import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { $logger } from "@/_libs";

import { formatSessionList } from "./format";
import { errorResult, resolveHost, textResult, toToolError } from "./tool-context";
import type { ToolContext } from "./tool-context";

export function registerSessionTools(server: McpServer, context: ToolContext): void {
    server.registerTool(
        "wsl_connect",
        {
            title: "Open a WSL session",
            description: [
                "Open a session in the configured distro and return its session id.",
                "A session remembers the working directory, so a 'cd' in one wsl_exec still applies to the next. Each command is still its own process — nothing else (environment variables, background jobs) persists between calls.",
                "Close it with wsl_disconnect when done; idle sessions are forgotten automatically.",
            ].join(" "),
            inputSchema: {
                cwd: z.string().optional().describe("Absolute directory to start in, with no shell metacharacters. Defaults to WSL_CWD, else the login shell's directory."),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ cwd }) => {
            let _logger = $logger.child({ context: "wsl_connect" });

            // Tracked outside the try so a probe that *throws* still tears the session
            // down — leaking it would burn one of the 32 slots until the sweeper ran.
            let openedSessionId: string | null = null;

            try {
                const { host } = resolveHost(context, {});
                const session = context.sessions.open(host);
                openedSessionId = session.sessionId;
                _logger = _logger.child({ session_id: session.sessionId });

                if (cwd != null && cwd.trim() !== "") {
                    session.cwd = cwd.trim();
                }

                // One `pwd` settles the real starting directory (proves `cwd` exists, starts
                // the distro if it was stopped), so the session reports a concrete path.
                const probe = await session.exec("pwd");

                const probeSucceeded = probe.exitCode === 0 && probe.timedOut == false;
                if (probeSucceeded == false) {
                    context.sessions.close(session.sessionId);
                    openedSessionId = null;
                    _logger.warn("session probe failed, closing the session", {
                        exit_code: probe.exitCode,
                        timed_out: probe.timedOut,
                        stderr: probe.stderr,
                    });
                    return errorResult(`wsl_connect failed: could not confirm the starting directory.\n${probe.stderr.trim()}`);
                }

                const profile = host.profile;
                const lines: string[] = [
                    `Opened session ${session.sessionId} → ${profile.username ?? "(distro default)"}@${profile.distro}`,
                    `cwd: ${session.cwd}`,
                ];

                if (profile.policy.readonly == true) {
                    lines.push("This distro is READ-ONLY: writes, redirections and uploads will be rejected.");
                }

                lines.push(`Run commands with wsl_exec({ session: "${session.sessionId}", command: "..." }).`);

                _logger.info("session opened via tool", { cwd: session.cwd });
                return textResult(lines.join("\n"));
            }
            catch (ex) {
                if (openedSessionId != null) {
                    context.sessions.close(openedSessionId);
                }
                return toToolError(ex, "wsl_connect", "open a session");
            }
        }
    );

    server.registerTool(
        "wsl_disconnect",
        {
            title: "Close a WSL session",
            description: "Close a session opened with wsl_connect. Nothing in the distro is affected — only this server's memory of the working directory.",
            inputSchema: {
                session: z.string().min(1).describe("Session id from wsl_connect."),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ session }) => {
            const _logger = $logger.child({ context: "wsl_disconnect", session_id: session });

            try {
                const closed = context.sessions.close(session.trim());
                if (closed == false) {
                    return errorResult(`no open session '${session}'`);
                }

                _logger.info("session closed via tool");
                return textResult(`Closed session ${session}.`);
            }
            catch (ex) {
                return toToolError(ex, "wsl_disconnect", `close session ${session}`);
            }
        }
    );

    server.registerTool(
        "wsl_list_sessions",
        {
            title: "List open WSL sessions",
            description: "List the sessions this server holds, with their working directory, command count and idle time.",
            inputSchema: {},
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            try {
                return textResult(formatSessionList(context.sessions.list()));
            }
            catch (ex) {
                return toToolError(ex, "wsl_list_sessions", "list sessions");
            }
        }
    );
}
