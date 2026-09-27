import { SINGLE_HOST_ENV } from "@/_defs";
import { formatBytes } from "@/_libs";
import type { GuardVerdict, WslDirectoryEntry, WslDistroStatus, WslExecResult, WslHostProfile, WslSessionInfo } from "@/_types";
import { toHostSummary } from "@/modules/config";
import type { DirectoryListing } from "@/modules/wsl";

const ENTRY_TYPE_MARKERS: Record<WslDirectoryEntry["type"], string> = {
    file: "-",
    directory: "d",
    symlink: "l",
    other: "?",
};

/**
 * Renders the configured distro for `wsl_list_hosts`, or setup instructions when none is
 * registered. `status` is what `wsl -l -v` (and, when running, a probe inside) reported.
 */
export function formatHostProfile(profile: WslHostProfile | null, status: WslDistroStatus | null): string {
    if (profile == null) {
        return [
            "No WSL distro is registered.",
            "",
            "Put the distro in this server's MCP entry — one server entry per distro and user:",
            "",
            `    "env": {`,
            `        "${SINGLE_HOST_ENV.DISTRO}": "ubuntu",`,
            `        "${SINGLE_HOST_ENV.USER}": "root"`,
            "    }",
            "",
            `${SINGLE_HOST_ENV.DISTRO} is the whole minimum (the name as 'wsl -l -q' prints it); ${SINGLE_HOST_ENV.USER} defaults to the distro's default user.`,
            "Restart this server after changing it — environment variables are fixed for the life of the process.",
        ].join("\n");
    }

    const summary = toHostSummary(profile);

    let accessLabel = "writable";
    if (summary.readonly == true) {
        accessLabel = "READ-ONLY";
    }

    let sudoLabel = "sudo=disabled";
    if (summary.allowSudo == true) {
        sudoLabel = "sudo=enabled";
    }

    let windowsLabel = "windows=locked (no interop .exe, no writes under /mnt/<drive>/)";
    if (summary.allowWindows == true) {
        windowsLabel = "windows=open (interop .exe and /mnt/<drive>/ writes allowed; operator credential and MCP config paths still refused)";
    }

    const lines: string[] = [];
    lines.push(`${summary.name}  →  ${summary.username}@${summary.distro} (WSL, this machine)  ${accessLabel}  ${sudoLabel}`);
    lines.push(`    ${windowsLabel}`);

    if (summary.description != null) {
        lines.push(`    ${summary.description}`);
    }

    if (status != null) {
        lines.push(`    ${formatDistroStatus(status)}`);
    }

    if (summary.allowedPaths.length > 0) {
        // Scope stated explicitly: allowedPaths binds the file tools only, and reading it
        // as a filesystem-wide restriction would be a dangerous misunderstanding —
        // wsl_exec can still `cat` anything the user can read.
        lines.push(`    file tools limited to: ${summary.allowedPaths.join(", ")} (does not restrict wsl_exec)`);
    }

    if (summary.allowCommands.length > 0) {
        lines.push(`    commands limited to: ${summary.allowCommands.join(", ")}`);
    }

    return lines.join("\n");
}

/** One line: installed / state / WSL version, plus the inside facts when they were probed. */
export function formatDistroStatus(status: WslDistroStatus): string {
    if (status.installed == false) {
        return "distro: NOT FOUND in 'wsl -l -v' — check the name (wsl -l -q) and the WSL_DISTRO variable";
    }

    const parts: string[] = [`distro: ${status.state}`];
    if (status.wslVersion != null) {
        parts.push(`WSL ${status.wslVersion}`);
    }
    if (status.networkingMode != null) {
        parts.push(`networking ${status.networkingMode}`);
    }
    if (status.systemd != null) {
        if (status.systemd == true) {
            parts.push("systemd");
        }
        else {
            parts.push("no systemd");
        }
    }
    if (status.kernel != null) {
        parts.push(`kernel ${status.kernel}`);
    }
    if (status.state === "Stopped") {
        parts.push("(the first command will start it)");
    }

    return parts.join("  ·  ");
}

/**
 * Renders a command result: a status line (exit code, duration, cwd), any timeout or
 * truncation notice, then the stdout and stderr sections.
 *
 * @param timeoutMs The limit that applied, quoted in the timeout notice.
 */
export function formatExecResult(result: WslExecResult, timeoutMs: number): string {
    const headerParts: string[] = [];

    if (result.exitCode != null) {
        headerParts.push(`exit code: ${result.exitCode}`);
    }
    else {
        headerParts.push("exit code: none (killed)");
    }

    if (result.signal != null) {
        headerParts.push(`signal: ${result.signal}`);
    }

    headerParts.push(`${result.durationMs}ms`);

    if (result.cwd != null) {
        headerParts.push(`cwd: ${result.cwd}`);
    }

    const lines: string[] = [headerParts.join("  ·  ")];

    if (result.timedOut == true) {
        lines.push(`TIMED OUT after ${timeoutMs}ms — wsl.exe was killed, but the process inside the distro may still be running.`);
    }

    if (result.truncated == true) {
        lines.push("Output was truncated; narrow the command (grep / head / tail) or raise WSL_MAX_OUTPUT for this profile.");
    }

    lines.push("");
    lines.push("--- stdout ---");
    if (result.stdout === "") {
        lines.push("(empty)");
    }
    else {
        lines.push(result.stdout);
    }

    if (result.stderr !== "") {
        lines.push("");
        lines.push("--- stderr ---");
        lines.push(result.stderr);
    }

    return lines.join("\n");
}

/** Rejection message: what was blocked, why, and what would make it legal. */
export function formatGuardRejection(action: string, verdict: GuardVerdict): string {
    const lines: string[] = [`Blocked by the host profile's guard policy: ${verdict.reason}`];

    if (verdict.offendingText != null && verdict.offendingText !== action) {
        lines.push(`Offending part: ${verdict.offendingText}`);
    }

    lines.push(`Requested: ${action}`);
    lines.push("Nothing was run in the distro. Adjust the request, or relax the profile's policy in the MCP entry.");

    return lines.join("\n");
}

/** Renders open sessions with distro, working directory, command count and idle time. */
export function formatSessionList(sessions: WslSessionInfo[]): string {
    if (sessions.length === 0) {
        return "No open WSL sessions. Open one with wsl_connect, or omit 'session' to run a one-off command.";
    }

    const lines: string[] = [`${sessions.length} open WSL session(s):`];
    const now = Date.now();

    for (const session of sessions) {
        const idleSeconds = Math.round((now - new Date(session.lastUsedAt).getTime()) / 1000);
        lines.push("");
        lines.push(`${session.sessionId}  →  ${session.username}@${session.distro}  profile: ${session.profileName}`);
        lines.push(`    cwd: ${session.cwd}  ·  ${session.execCount} command(s)  ·  idle ${idleSeconds}s  ·  opened ${session.openedAt}`);
    }

    return lines.join("\n");
}

/**
 * Renders a directory listing as one row per entry (type, mode, size, mtime, name),
 * noting the true total when the listing was capped.
 */
export function formatDirectoryListing(distroPath: string, listing: DirectoryListing): string {
    if (listing.totalCount === 0) {
        return `${distroPath} is empty.`;
    }

    let header = `${distroPath} — ${listing.totalCount} entrie(s):`;
    if (listing.truncated == true) {
        header = `${distroPath} — ${listing.totalCount} entrie(s), showing the first ${listing.entries.length}:`;
    }

    const lines: string[] = [header, ""];

    for (const entry of listing.entries) {
        const marker = ENTRY_TYPE_MARKERS[entry.type];
        const size = formatBytes(entry.sizeBytes).padStart(9);

        let name = entry.name;
        if (entry.type === "directory") {
            name = `${entry.name}/`;
        }

        lines.push(`${marker}  ${entry.mode}  ${size}  ${entry.modifiedAt}  ${name}`);
    }

    if (listing.truncated == true) {
        lines.push("");
        lines.push("Listing was capped; narrow the path or filter with wsl_exec if you need the rest.");
    }

    return lines.join("\n");
}
