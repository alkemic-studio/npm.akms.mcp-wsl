import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { SINGLE_HOST_ENV } from "@/_defs";
import { $logger } from "@/_libs";
import { GuardRejectionError } from "@/modules/guard";
import { WslHost, WslSession, WslSessionManager } from "@/modules/wsl";

import { formatGuardRejection } from "./format";

/** Everything the tool handlers share: the configured distro and the live sessions. */
export interface ToolContext {
    /** The distro from the `WSL_*` variables, or null when none is registered. */
    host: WslHost | null;
    sessions: WslSessionManager;
}

export function textResult(text: string): CallToolResult {
    return { content: [{ type: "text", text: text }] };
}

/** Marked `isError` so the model sees the call failed rather than reading it as output. */
export function errorResult(message: string): CallToolResult {
    return { content: [{ type: "text", text: message }], isError: true };
}

export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

/**
 * Renders a failure for the model, separating the two cases it must treat differently:
 * a guard rejection is a policy decision not worth retrying, anything else is an
 * operational failure that might succeed on a second attempt.
 */
export function toToolError(error: unknown, toolName: string, action: string): CallToolResult {
    const _logger = $logger.child({ context: toolName });

    if (error instanceof GuardRejectionError) {
        _logger.warn("rejected by the guard", { reason: error.verdict.reason, action: action });

        const rendered = formatGuardRejection(action, error.verdict);
        return errorResult(rendered);
    }

    _logger.error(error, `${toolName} failed`);
    return errorResult(`${toolName} failed: ${describeError(error)}`);
}

/**
 * Resolves the optional `session` argument to the host, without running anything.
 *
 * There is no distro argument — this server fronts exactly the distro in its own env
 * block, which is what keeps the model from being able to name one.
 *
 * @throws {Error} If no distro is registered, or the session id is not open.
 */
export function resolveHost(
    context: ToolContext,
    args: { session?: string }
): { host: WslHost; session: WslSession | null } {
    const hasSession = args.session != null && args.session.trim() !== "";
    if (hasSession == true) {
        const session = context.sessions.require((args.session as string).trim());
        return { host: session.host, session: session };
    }

    if (context.host == null) {
        throw new Error(`no distro is registered — set ${SINGLE_HOST_ENV.DISTRO} (and optionally ${SINGLE_HOST_ENV.USER}) in this server's env block, then restart it`);
    }

    return { host: context.host, session: null };
}
