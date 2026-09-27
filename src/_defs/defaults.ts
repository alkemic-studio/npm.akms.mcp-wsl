/** Env var overriding the stderr log level ("debug" | "info" | "warn" | "error" | "silent"). */
export const LOG_LEVEL_ENV = "WSL_MCP_LOG_LEVEL";

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/** stdout / stderr cutoff — roughly 25k tokens of context at worst. */
export const DEFAULT_MAX_OUTPUT_CHARACTERS = 100_000;

export const DEFAULT_MAX_READ_FILE_BYTES = 200_000;

/** Raw bytes buffered per stream before the process is killed — a runaway `cat /dev/zero` must not take the server with it. */
export const OUTPUT_HARD_CAP_MULTIPLIER = 4;

/** Sessions untouched for this long are forgotten by the sweeper. */
export const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export const SESSION_SWEEP_INTERVAL_MS = 60_000;

/** Ceiling on simultaneously running `wsl.exe` processes, so a runaway tool batch can't fork-bomb the host. */
export const MAX_CONCURRENT_PROCESSES = 32;

/** Emitted after the user command so a session can track `cd` between execs. */
export const CWD_MARKER = "__AKMS_WSL_CWD__";

/** `wsl_list_dir` stops here — a directory with 500k entries would otherwise return megabytes. */
export const MAX_DIRECTORY_ENTRIES = 1_000;

/** Resolved through PATH: `C:\Windows\System32\wsl.exe`, or the Store build under WindowsApps. */
export const WSL_EXECUTABLE = "wsl.exe";

/**
 * Exit status `wsl.exe` returns when *it* failed (unknown distro, service down) rather than
 * the Linux command. Node reports the uint32 form on Windows; `-1` is kept for safety.
 */
export const WSL_FAILURE_EXIT_CODES = [4294967295, -1];

export const SERVER_NAME = "akms-mcp-wsl";

export const SERVER_VERSION = "0.0.2";
