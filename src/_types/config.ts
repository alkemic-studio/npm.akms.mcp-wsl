import type { SshPolicy } from "@akms/mcp-ssh";

/**
 * Guard rules applied to every command / file operation in the distro.
 *
 * The `@akms/mcp-ssh` policy verbatim, so its guards accept it unchanged. `connectTimeoutMs`
 * has no meaning here (nothing connects) and is carried as 0.
 */
export type WslPolicy = SshPolicy;

/** The registered distro: which one, as whom, what is permitted. */
export interface WslHostProfile {
    /** Alias shown to the model, from `WSL_NAME`; defaults to the distro name. */
    name: string;
    /** Distro name as `wsl -l -q` prints it. */
    distro: string;
    /** Linux user passed as `wsl -u`; the distro's default user when absent. */
    username?: string;
    description?: string;
    /** Directory every session starts in; falls back to the login shell's default. */
    defaultCwd?: string;
    /**
     * Whether the agent may leave the distro for Windows — run interop executables, or
     * write under `/mnt/<drive>/`. Off by default: those paths reach the machine that runs
     * this server and holds its configuration.
     */
    allowWindows: boolean;
    policy: WslPolicy;
}

/** View of the profile handed back to the model. */
export interface WslHostSummary {
    name: string;
    distro: string;
    /** The configured user, or the distro default when none was set. */
    username: string;
    description?: string;
    readonly: boolean;
    allowSudo: boolean;
    allowWindows: boolean;
    allowedPaths: string[];
    allowCommands: string[];
}
