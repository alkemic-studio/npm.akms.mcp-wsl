import {
    DEFAULT_EXEC_TIMEOUT_MS,
    DEFAULT_MAX_OUTPUT_CHARACTERS,
    DEFAULT_MAX_READ_FILE_BYTES,
    FALSY_ENV_VALUES,
    SINGLE_HOST_ENV,
    TRUTHY_ENV_VALUES,
} from "@/_defs";
import { $logger } from "@/_libs";
import type { WslHostProfile, WslHostSummary, WslPolicy } from "@/_types";

/** Trimmed value, or undefined when the variable is unset or blank. */
function readEnv(name: string): string | undefined {
    const value = process.env[name];
    if (value == null) {
        return undefined;
    }

    const trimmed = value.trim();
    if (trimmed === "") {
        return undefined;
    }

    return trimmed;
}

/**
 * @throws {Error} If the value is set but is neither a truthy nor a falsy spelling —
 *                 `WSL_READONLY=ture` must fail loudly, not resolve to "not read-only".
 */
function readBooleanEnv(name: string): boolean | undefined {
    const value = readEnv(name);
    if (value == null) {
        return undefined;
    }

    const normalized = value.toLowerCase();
    if (TRUTHY_ENV_VALUES.includes(normalized) == true) {
        return true;
    }

    if (FALSY_ENV_VALUES.includes(normalized) == false) {
        throw new Error(`${name} must be one of ${[...TRUTHY_ENV_VALUES, ...FALSY_ENV_VALUES].join(", ")} (got "${value}")`);
    }

    return false;
}

/**
 * @throws {Error} If the value is set but is not a positive integer.
 */
function readIntegerEnv(name: string): number | undefined {
    const value = readEnv(name);
    if (value == null) {
        return undefined;
    }

    const parsed = Number(value);
    if (Number.isInteger(parsed) == false || parsed <= 0) {
        throw new Error(`${name} must be a positive integer (got "${value}")`);
    }

    return parsed;
}

/** Comma-separated list, blanks dropped. */
function readListEnv(name: string): string[] | undefined {
    const value = readEnv(name);
    if (value == null) {
        return undefined;
    }

    const items = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
    if (items.length === 0) {
        return undefined;
    }

    return items;
}

/**
 * Compiles `WSL_DENY_PATTERNS` at startup, so a typo'd regex aborts the server instead
 * of silently not being in force at the moment it matters.
 *
 * @throws {Error} If a pattern is not a valid regular expression.
 */
function compileDenyPatterns(sources: string[]): RegExp[] {
    return sources.map((source) => {
        try {
            return new RegExp(source, "i");
        }
        catch (ex) {
            let detail = String(ex);
            if (ex instanceof Error) {
                detail = ex.message;
            }

            throw new Error(`${SINGLE_HOST_ENV.DENY_PATTERNS} has an invalid entry /${source}/: ${detail}`);
        }
    });
}

/**
 * Builds the profile from the `WSL_*` variables, or null when `WSL_DISTRO` is unset.
 *
 * The distro is required by name rather than falling back to `wsl --set-default`'s pick:
 * that default is a machine-wide setting anyone can change, and a server silently
 * following it would one day run every command in a different distro than the entry
 * says. A malformed value aborts startup rather than being ignored, because silently
 * dropping `WSL_READONLY` would leave a distro the operator believed was read-only
 * fully writable.
 *
 * Flow:
 *  1) Guard: no `WSL_DISTRO` means nothing is registered — the server still starts and says so
 *  2) Resolve the policy over the built-in permissive stance; each variable is opt-in restriction
 *  3) Assemble the profile
 *
 * @throws {Error} If a typed value is malformed.
 */
export function loadHostProfile(): WslHostProfile | null {
    // (1) Guard — a missing distro is not an error: the server reports "not configured"
    // through the tools, which is a far clearer signal to the model than a dead server.
    const distro = readEnv(SINGLE_HOST_ENV.DISTRO);
    if (distro == null) {
        const _startupLogger = $logger.child({ context: "loadHostProfile" });
        _startupLogger.warn("no distro is registered; set the distro variable and restart", {
            env_vars: [SINGLE_HOST_ENV.DISTRO],
        });
        return null;
    }

    const name = readEnv(SINGLE_HOST_ENV.NAME) ?? distro;
    const _logger = $logger.child({ context: "loadHostProfile", profile: name });

    // (2) Policy — the built-in stance is permissive: an unconfigured distro allows
    // everything except the catastrophe rules, because a guard nobody can work through
    // gets turned off wholesale rather than tuned. The one exception is Windows access,
    // which is opt-in — see `WslHostProfile.allowWindows`.
    const allowCommands = readListEnv(SINGLE_HOST_ENV.ALLOW_COMMANDS) ?? [];

    // `wsl_connect` probes with `pwd` to settle the session's starting directory; without
    // this an allow-list profile could never open a session at all.
    if (allowCommands.length > 0 && allowCommands.includes("pwd") == false) {
        allowCommands.push("pwd");
    }

    const policy: WslPolicy = {
        readonly: readBooleanEnv(SINGLE_HOST_ENV.READONLY) ?? false,
        allowSudo: readBooleanEnv(SINGLE_HOST_ENV.ALLOW_SUDO) ?? true,
        execTimeoutMs: readIntegerEnv(SINGLE_HOST_ENV.EXEC_TIMEOUT_MS) ?? DEFAULT_EXEC_TIMEOUT_MS,
        // Nothing connects; carried only because the shared policy type declares it.
        connectTimeoutMs: 0,
        maxOutputCharacters: readIntegerEnv(SINGLE_HOST_ENV.MAX_OUTPUT_CHARACTERS) ?? DEFAULT_MAX_OUTPUT_CHARACTERS,
        maxReadFileBytes: readIntegerEnv(SINGLE_HOST_ENV.MAX_READ_FILE_BYTES) ?? DEFAULT_MAX_READ_FILE_BYTES,
        allowCommands: allowCommands,
        denyPatterns: compileDenyPatterns(readListEnv(SINGLE_HOST_ENV.DENY_PATTERNS) ?? []),
        allowedPaths: readListEnv(SINGLE_HOST_ENV.ALLOWED_PATHS) ?? [],
    };

    // (3) Profile
    const profile: WslHostProfile = {
        name: name,
        distro: distro,
        username: readEnv(SINGLE_HOST_ENV.USER),
        description: readEnv(SINGLE_HOST_ENV.DESCRIPTION),
        defaultCwd: readEnv(SINGLE_HOST_ENV.CWD),
        allowWindows: readBooleanEnv(SINGLE_HOST_ENV.ALLOW_WINDOWS) ?? false,
        policy: policy,
    };

    _logger.info("host profile loaded", {
        distro: distro,
        username: profile.username ?? "(distro default)",
        readonly: policy.readonly,
        allow_windows: profile.allowWindows,
    });

    return profile;
}

/** The profile as described back to the model. Nothing secret lives in a WSL profile, but the shape mirrors mcp-ssh. */
export function toHostSummary(profile: WslHostProfile): WslHostSummary {
    return {
        name: profile.name,
        distro: profile.distro,
        username: profile.username ?? "(distro default)",
        description: profile.description,
        readonly: profile.policy.readonly,
        allowSudo: profile.policy.allowSudo,
        allowWindows: profile.allowWindows,
        allowedPaths: profile.policy.allowedPaths,
        allowCommands: profile.policy.allowCommands,
    };
}
