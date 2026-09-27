/** One deny rule: a regex tested against a segment's normalized text plus the message shown on a hit. */
export interface CommandRule {
    pattern: RegExp;
    reason: string;
}

/**
 * Catastrophe rules specific to a WSL host, on top of `@akms/mcp-ssh`'s (which already
 * refuse `shutdown` / `reboot`). The criterion is the same: an operation that kills the
 * machine this server is working through, or cuts the channel it works through. Tested
 * against `analyzeSegment(...).normalizedText`, which starts at the binary.
 */
export const WSL_CATASTROPHE_RULES: CommandRule[] = [
    {
        pattern: /^wsl(?:\.exe)?\b.*\s-(?:-shutdown|-terminate|-unregister|t)(?:\s|$)/i,
        reason: "stops or removes the distro this server runs in (wsl --shutdown / --terminate / --unregister)",
    },
    {
        pattern: /^wslconfig(?:\.exe)?\b.*\s\/(?:t|u)\b/i,
        reason: "terminates or unregisters the distro this server runs in (wslconfig /t, /u)",
    },
    {
        pattern: /^(?:poweroff|halt)\b/,
        reason: "powers off the distro this server runs in",
    },
    {
        pattern: /^systemctl\b.*\b(?:poweroff|halt|reboot|kexec|suspend|hibernate)\b/,
        reason: "powers off or restarts the distro this server runs in",
    },
    {
        pattern: /^(?:telinit|init)\s+[06]\b/,
        reason: "halts or reboots the distro this server runs in",
    },
];

/**
 * Binaries that leave the distro for Windows through interop. Matched against the
 * segment's resolved binary basename, so `/mnt/c/Windows/System32/cmd.exe` and `cmd.exe`
 * read the same. The extension rule catches every other Windows executable.
 */
export const WINDOWS_INTEROP_BINARY_PATTERN = new RegExp(
    "^(?:"
    + "(?:powershell|pwsh|cmd|explorer|wsl|wslconfig|wslview|reg|regedit|schtasks|sc|net|netsh|taskkill|tasklist|mshta|rundll32|wscript|cscript|msiexec|start|winget|choco|scoop)(?:\\.exe|\\.cmd|\\.bat)?"
    + "|.*\\.(?:exe|cmd|bat|ps1|msi|com)"
    + ")$",
    "i"
);

/** Every `/mnt/<drive>/…` reference in a segment, quotes or not — the threat model is a mistaken agent, not an adversary. */
export const MOUNT_PATH_PATTERN = /\/mnt\/([a-z])(\/[^\s'"|;&<>]*)?/gi;
