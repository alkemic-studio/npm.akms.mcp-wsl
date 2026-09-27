import { afterEach, describe, expect, it } from "vitest";

import { SINGLE_HOST_ENV } from "@/_defs";
import { loadHostProfile, toHostSummary } from "@/modules/config";

process.env.WSL_MCP_LOG_LEVEL = "silent";

const MANAGED_VARIABLES = Object.values(SINGLE_HOST_ENV);

function clearEnv(): void {
    for (const name of MANAGED_VARIABLES) {
        delete process.env[name];
    }
}

afterEach(clearEnv);

describe("loadHostProfile", () => {
    it("returns null with nothing registered", () => {
        clearEnv();
        expect(loadHostProfile()).toBeNull();
    });

    it("needs only the distro; the user falls back to the distro default", () => {
        clearEnv();
        process.env.WSL_DISTRO = "ubuntu";

        const profile = loadHostProfile();
        expect(profile).not.toBeNull();
        expect(profile?.distro).toBe("ubuntu");
        expect(profile?.username).toBeUndefined();
        expect(profile?.name).toBe("ubuntu");
        expect(toHostSummary(profile!).username).toBe("(distro default)");
    });

    it("is permissive by default except for Windows access", () => {
        clearEnv();
        process.env.WSL_DISTRO = "ubuntu";

        const profile = loadHostProfile()!;
        expect(profile.policy.readonly).toBe(false);
        expect(profile.policy.allowSudo).toBe(true);
        expect(profile.allowWindows).toBe(false);
        expect(profile.policy.connectTimeoutMs).toBe(0);
    });

    it("maps every variable", () => {
        clearEnv();
        process.env.WSL_DISTRO = "ubuntu";
        process.env.WSL_USER = "zinnalab";
        process.env.WSL_NAME = "lab";
        process.env.WSL_DESCRIPTION = "test stack";
        process.env.WSL_CWD = "/home/app";
        process.env.WSL_READONLY = "yes";
        process.env.WSL_ALLOW_SUDO = "0";
        process.env.WSL_ALLOW_WINDOWS = "on";
        process.env.WSL_ALLOW_COMMANDS = "ls, cat";
        process.env.WSL_DENY_PATTERNS = "^docker";
        process.env.WSL_ALLOWED_PATHS = "/var/log,/opt";
        process.env.WSL_EXEC_TIMEOUT_MS = "5000";
        process.env.WSL_MAX_OUTPUT = "10";
        process.env.WSL_MAX_READ_BYTES = "20";

        const profile = loadHostProfile()!;
        expect(profile.username).toBe("zinnalab");
        expect(profile.name).toBe("lab");
        expect(profile.description).toBe("test stack");
        expect(profile.defaultCwd).toBe("/home/app");
        expect(profile.policy.readonly).toBe(true);
        expect(profile.policy.allowSudo).toBe(false);
        expect(profile.allowWindows).toBe(true);
        // `pwd` is added so wsl_connect's probe can run on an allow-list profile.
        expect(profile.policy.allowCommands).toEqual(["ls", "cat", "pwd"]);
        expect(profile.policy.denyPatterns.map((pattern) => pattern.source)).toEqual(["^docker"]);
        expect(profile.policy.allowedPaths).toEqual(["/var/log", "/opt"]);
        expect(profile.policy.execTimeoutMs).toBe(5000);
        expect(profile.policy.maxOutputCharacters).toBe(10);
        expect(profile.policy.maxReadFileBytes).toBe(20);
    });

    it("fails startup on a malformed boolean rather than defaulting", () => {
        clearEnv();
        process.env.WSL_DISTRO = "ubuntu";
        process.env.WSL_READONLY = "ture";
        expect(() => loadHostProfile()).toThrow(/WSL_READONLY/);
    });

    it("fails startup on an invalid deny pattern", () => {
        clearEnv();
        process.env.WSL_DISTRO = "ubuntu";
        process.env.WSL_DENY_PATTERNS = "(";
        expect(() => loadHostProfile()).toThrow(/WSL_DENY_PATTERNS/);
    });
});
