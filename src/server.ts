import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_NAME, SERVER_VERSION } from "@/_defs";
import { $logger } from "@/_libs";
import type { WslHostProfile } from "@/_types";
import { loadHostProfile } from "@/modules/config";
import { WslHost, WslSessionManager } from "@/modules/wsl";
import { registerAllTools } from "@/modules/tools";
import type { ToolContext } from "@/modules/tools";

export interface WslMcpServerInstance {
    server: McpServer;
    sessions: WslSessionManager;
    /** The distro read from the `WSL_*` variables at startup, or null when none is set. */
    readonly profile: WslHostProfile | null;
    /** Stops the sweeper and forgets every open session. Call before the process exits. */
    shutdown(): void;
}

/** Handed to the client on connect, so the model knows the workflow before its first call. */
const SERVER_INSTRUCTIONS = [
    "This server runs shell commands and transfers files in one WSL distro on this machine, through wsl.exe — no SSH, no network.",
    "The distro and the Linux user are fixed in this server's own environment — there is no distro or user argument, and no other machine is reachable through it.",
    "",
    "wsl_list_hosts shows which distro and user this is, whether the distro is running, its networking mode, and what it permits. Call it before assuming anything about access or ports.",
    "",
    "Workflow:",
    "1. One command: wsl_exec with just 'command'.",
    "2. Several commands in a row: wsl_connect once, then wsl_exec with 'session' (the working directory persists across calls), then wsl_disconnect. Only the directory persists — each command is its own process.",
    "3. Files: wsl_list_dir, wsl_read_file, wsl_write_file, wsl_upload, wsl_download — prefer these over shell equivalents; no quoting to get wrong.",
    "",
    "What is permitted: ordinary administration, without asking — package installs, service restarts, sudo, interpreters, config edits, deployments.",
    "Refused always: operations that destroy the distro or cut this channel — wiping the filesystem root or a system directory, deleting a file the distro cannot boot without, formatting a disk, writing raw bytes to a block device, powering off, wsl --shutdown / --terminate / --unregister, flushing the firewall, removing every cron job.",
    "Refused unless the profile opens them (WSL_ALLOW_WINDOWS): running Windows executables through interop (powershell.exe, cmd.exe, any .exe) and writing under /mnt/<drive>/. Reading under /mnt/<drive>/ is allowed. The operator's credential files and MCP configuration under /mnt/ are refused regardless — those define this very guard.",
    "The profile may add its own limits (read-only, an allow-list, deny patterns, path restrictions). wsl_list_hosts shows which apply.",
    "",
    "Commands run in a login bash with no terminal and with stdin closed, so anything that waits for input fails immediately instead of hanging: use non-interactive flags (apt-get -y, sudo -n), 'top -bn1' rather than 'top', and wsl_write_file rather than an editor.",
    "A job that may outlive its timeout must be detached with all three descriptors redirected — nohup cmd > log 2>&1 < /dev/null & — otherwise wsl.exe waits on the open pipe until the timeout. Poll it through its log.",
    "",
    "A guard rejection is a policy decision, not a transient failure — do not retry the same command; report it and ask before working around it.",
    "A non-zero exit code is returned as normal output; read it and stderr to judge what happened.",
    "You still carry the judgement the guards do not: this is a real host, and an irreversible action deserves a check with the operator first.",
].join("\n");

/**
 * Builds the MCP server: reads the distro from the environment, wires the session
 * manager, registers tools.
 *
 * Transport is deliberately left to the caller — `cli.ts` attaches stdio, tests can attach
 * an in-memory pair.
 *
 * @throws {Error} If the `WSL_*` variables are malformed (a bad policy value must not
 *                 silently degrade into "no guard").
 */
export function createWslMcpServer(): WslMcpServerInstance {
    const _logger = $logger.child({ context: "createWslMcpServer" });

    const profile = loadHostProfile();

    let host: WslHost | null = null;
    if (profile != null) {
        host = new WslHost(profile);
    }

    const sessions = new WslSessionManager();
    sessions.startIdleSweeper();

    const server = new McpServer(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        {
            instructions: SERVER_INSTRUCTIONS,
        }
    );

    const context: ToolContext = {
        host: host,
        sessions: sessions,
    };

    registerAllTools(server, context);

    _logger.info("mcp server built", { profile: profile?.name ?? null });

    return {
        server: server,
        sessions: sessions,
        profile: profile,
        shutdown(): void {
            sessions.stopIdleSweeper();
            sessions.closeAll();
        },
    };
}
