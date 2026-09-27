/**
 * Environment variables that define the distro, one MCP server entry per distro + user.
 *
 * The `SSH_*` surface of `@akms/mcp-ssh` with the connection and authentication
 * variables removed — there is no connection, `wsl.exe` is the transport.
 */
export const SINGLE_HOST_ENV = {
    /** Presence of this variable is what registers a distro at all. Name as `wsl -l -q` prints it. */
    DISTRO: "WSL_DISTRO",
    /** Linux user to run as (`wsl -u`); the distro's default user when unset. */
    USER: "WSL_USER",
    /** Alias shown to the model; defaults to the distro name. */
    NAME: "WSL_NAME",
    DESCRIPTION: "WSL_DESCRIPTION",
    /** Directory new sessions start in. */
    CWD: "WSL_CWD",
    READONLY: "WSL_READONLY",
    ALLOW_SUDO: "WSL_ALLOW_SUDO",
    /** Interop `.exe` execution and writes under `/mnt/<drive>/`. Default false. */
    ALLOW_WINDOWS: "WSL_ALLOW_WINDOWS",
    /** Comma-separated binary names. */
    ALLOW_COMMANDS: "WSL_ALLOW_COMMANDS",
    /** Comma-separated regex sources. */
    DENY_PATTERNS: "WSL_DENY_PATTERNS",
    /** Comma-separated absolute path prefixes. */
    ALLOWED_PATHS: "WSL_ALLOWED_PATHS",
    EXEC_TIMEOUT_MS: "WSL_EXEC_TIMEOUT_MS",
    MAX_OUTPUT_CHARACTERS: "WSL_MAX_OUTPUT",
    MAX_READ_FILE_BYTES: "WSL_MAX_READ_BYTES",
} as const;

/** Accepted spellings for a true boolean env value. */
export const TRUTHY_ENV_VALUES = ["true", "1", "yes", "on"];

/** Accepted spellings for a false boolean env value. */
export const FALSY_ENV_VALUES = ["false", "0", "no", "off"];
