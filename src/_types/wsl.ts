/** Outcome of one command in the distro. */
export interface WslExecResult {
    stdout: string;
    stderr: string;
    /** Exit status of the Linux command; null when `wsl.exe` was killed before it reported one. */
    exitCode: number | null;
    /** Signal that killed `wsl.exe`, e.g. "SIGTERM". */
    signal?: string;
    /** True when the timeout fired before the command finished. */
    timedOut: boolean;
    /** True when stdout or stderr hit `maxOutputCharacters` and was cut. */
    truncated: boolean;
    /** Working directory after the command ran; only tracked for session-bound execs. */
    cwd?: string;
    durationMs: number;
}

/** Live session as reported by `wsl_list_sessions`. */
export interface WslSessionInfo {
    sessionId: string;
    profileName: string;
    distro: string;
    username: string;
    cwd: string;
    /** ISO-8601 timestamps. */
    openedAt: string;
    lastUsedAt: string;
    execCount: number;
}

/** One entry of a directory listing. */
export interface WslDirectoryEntry {
    name: string;
    type: "file" | "directory" | "symlink" | "other";
    sizeBytes: number;
    /** Octal permission string, e.g. "0644". */
    mode: string;
    modifiedAt: string;
}

/** What `wsl.exe -l -v` and a probe inside the distro report — the facts infra-wsl reasoning needs. */
export interface WslDistroStatus {
    /** False when `wsl -l -v` does not list the distro at all. */
    installed: boolean;
    state: "Running" | "Stopped" | "Installing" | "unknown";
    /** WSL 1 or 2, from the listing. */
    wslVersion?: number;
    /** `wslinfo --networking-mode`: nat / mirrored / …; only probed while the distro runs. */
    networkingMode?: string;
    /** True when PID 1 is systemd. */
    systemd?: boolean;
    kernel?: string;
}
