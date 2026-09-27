import { CWD_MARKER } from "@/_defs";
import { quoteShellArgument } from "@/_libs";
import type { WslHostProfile } from "@/_types";

/**
 * The `wsl.exe` argument vector for running `script` in the profile's distro as its user.
 *
 * `--exec`, never `--`. With `--`, wsl.exe hands the arguments to the distro's *default
 * shell* for a second parse: backslashes vanish (`printf '\n'` breaks, `find … \;`
 * breaks) and `$HOME` / `$PATH` are expanded before bash ever sees the script — that is,
 * before the text the guard screened is the text that runs. `--exec` is a straight
 * execve, so the argument arrives byte for byte; `bash -lc` then gives the login
 * environment (PATH from `.profile`, nvm) that `--exec` alone would skip.
 */
export function buildWslArguments(profile: WslHostProfile, script: string): string[] {
    const wslArguments: string[] = ["-d", profile.distro];

    if (profile.username != null) {
        wslArguments.push("-u", profile.username);
    }

    wslArguments.push("--exec", "bash", "-lc", script);
    return wslArguments;
}

/**
 * Wraps the user command so bash reports where it ended up.
 *
 * The `cd` is done inside the script rather than with `wsl --cd`: a missing directory
 * makes `--cd` fall back to `/` with exit 0 and a warning on stderr, so the command
 * would run in the wrong place and look successful.
 *
 * `$?` is captured before the marker is printed and replayed via `exit`, so the exit
 * status the caller sees is the command's, not `printf`'s.
 *
 * `cwd` appears exactly once, inside `quoteShellArgument`. It must never be interpolated
 * anywhere else — echoing it into a double-quoted diagnostic would let
 * `cwd: '/x"; rm -rf /; #'` run arbitrary commands with every guard bypassed. The
 * failure message is therefore a fixed string.
 */
export function buildDistroScript(command: string, cwd: string | undefined, trackCwd: boolean): string {
    const lines: string[] = [];

    if (cwd != null && cwd !== "") {
        const quotedCwd = quoteShellArgument(cwd);
        lines.push(`cd ${quotedCwd} 2>/dev/null || { echo 'akms-mcp-wsl: cannot enter the requested working directory' >&2; exit 1; }`);
    }

    lines.push(command);

    if (trackCwd == true) {
        lines.push("__akms_exit=$?");
        lines.push(`printf '\\n${CWD_MARKER}%s' "$PWD"`);
        lines.push("exit $__akms_exit");
    }

    return lines.join("\n");
}

/** Splits the trailing `$PWD` marker off stdout. */
export function extractCwdMarker(stdout: string): { output: string; cwd?: string } {
    const markerIndex = stdout.lastIndexOf(CWD_MARKER);
    if (markerIndex < 0) {
        return { output: stdout };
    }

    // First line only: `$PWD` is a single line, so anything past a newline is not the
    // directory and must not end up in the `cd` prefix of the next command.
    const markerPayload = stdout.slice(markerIndex + CWD_MARKER.length);
    const cwd = (markerPayload.split("\n")[0] ?? "").trim();

    let output = stdout.slice(0, markerIndex);
    if (output.endsWith("\n") == true) {
        output = output.slice(0, -1);
    }

    if (cwd === "") {
        return { output: output };
    }

    return { output: output, cwd: cwd };
}
