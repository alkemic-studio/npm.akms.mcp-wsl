import { LOG_LEVEL_ENV } from "@/_defs";

export type LogLevel = "silent" | "debug" | "info" | "warn" | "error";

export interface Logger {
    /** Returns a logger that appends `meta` to every record it writes. */
    child(meta: Record<string, unknown>): Logger;
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(error: unknown, message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
    silent: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
};

/** Meta keys whose values never reach the log output. */
const SECRET_META_KEYS = ["password", "passphrase", "secret", "token"];

function resolveThreshold(): LogLevel {
    const configured = process.env[LOG_LEVEL_ENV];
    if (configured == null) {
        return "info";
    }

    // Own-property check: a plain `LEVEL_WEIGHTS[x] == null` test walks the prototype, so
    // WSL_MCP_LOG_LEVEL=constructor would pass validation and disable all filtering.
    const normalized = configured.toLowerCase() as LogLevel;
    if (Object.hasOwn(LEVEL_WEIGHTS, normalized) == false) {
        return "info";
    }

    return normalized;
}

function maskSecrets(meta: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
        if (SECRET_META_KEYS.includes(key.toLowerCase()) == true) {
            masked[key] = "***";
            continue;
        }
        masked[key] = value;
    }

    return masked;
}

function describeError(error: unknown): string {
    if (error instanceof Error) {
        if (error.stack != null) {
            return error.stack;
        }
        return error.message;
    }

    return String(error);
}

/**
 * Writes one line to stderr — stdout is the MCP protocol channel and must stay clean.
 * The threshold is read per call so `--check` can silence the logger after imports ran.
 */
function write(level: LogLevel, message: string, meta: Record<string, unknown>): void {
    const threshold = resolveThreshold();
    if (threshold === "silent") {
        return;
    }

    if (LEVEL_WEIGHTS[level] < LEVEL_WEIGHTS[threshold]) {
        return;
    }

    const record = {
        time: new Date().toISOString(),
        level: level,
        message: message,
        ...maskSecrets(meta),
    };
    process.stderr.write(`${JSON.stringify(record)}\n`);
}

function createLogger(baseMeta: Record<string, unknown>): Logger {
    return {
        child(meta: Record<string, unknown>): Logger {
            return createLogger({ ...baseMeta, ...meta });
        },
        debug(message: string, meta?: Record<string, unknown>): void {
            write("debug", message, { ...baseMeta, ...meta });
        },
        info(message: string, meta?: Record<string, unknown>): void {
            write("info", message, { ...baseMeta, ...meta });
        },
        warn(message: string, meta?: Record<string, unknown>): void {
            write("warn", message, { ...baseMeta, ...meta });
        },
        error(error: unknown, message: string, meta?: Record<string, unknown>): void {
            write("error", message, { ...baseMeta, ...meta, error: describeError(error) });
        },
    };
}

export const $logger: Logger = createLogger({});
