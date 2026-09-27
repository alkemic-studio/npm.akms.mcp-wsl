import type { WslHostProfile, WslPolicy } from "@/_types";

/** Default policy: permissive, matching what an unconfigured distro resolves to. */
export function createPolicy(overrides?: Partial<WslPolicy>): WslPolicy {
    return {
        readonly: false,
        allowSudo: true,
        execTimeoutMs: 60_000,
        connectTimeoutMs: 0,
        maxOutputCharacters: 100_000,
        maxReadFileBytes: 200_000,
        allowCommands: [],
        denyPatterns: [],
        allowedPaths: [],
        ...overrides,
    };
}

export function createProfile(overrides?: Partial<WslHostProfile>): WslHostProfile {
    return {
        name: "mock",
        distro: "ubuntu",
        username: "root",
        allowWindows: false,
        policy: createPolicy(),
        ...overrides,
    };
}

/** Distro the live tests run in; unset skips them (CI on Linux, a machine without WSL). */
export const LIVE_DISTRO = process.env.MCP_WSL_TEST_DISTRO ?? "";
export const LIVE_USER = process.env.MCP_WSL_TEST_USER ?? "root";
export const LIVE_ENABLED = process.platform === "win32" && LIVE_DISTRO !== "";
