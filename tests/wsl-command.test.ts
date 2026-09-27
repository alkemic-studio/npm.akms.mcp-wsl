import { describe, expect, it } from "vitest";

import { CWD_MARKER } from "@/_defs";
import { buildDistroScript, buildWslArguments, extractCwdMarker } from "@/modules/wsl";

import { createProfile } from "./_helpers";

describe("buildWslArguments", () => {
    it("uses --exec with a login bash and passes the script as one argument", () => {
        const wslArguments = buildWslArguments(createProfile({ distro: "ubuntu", username: "root" }), "printf '%s\\n' 'x\\y'");
        expect(wslArguments).toEqual(["-d", "ubuntu", "-u", "root", "--exec", "bash", "-lc", "printf '%s\\n' 'x\\y'"]);
    });

    it("omits -u when no user is configured", () => {
        const wslArguments = buildWslArguments(createProfile({ username: undefined }), "id");
        expect(wslArguments).toEqual(["-d", "ubuntu", "--exec", "bash", "-lc", "id"]);
    });

    it("never uses -- (the default shell would re-parse the script)", () => {
        expect(buildWslArguments(createProfile(), "id")).not.toContain("--");
    });
});

describe("buildDistroScript", () => {
    it("runs the command as-is without cwd or tracking", () => {
        expect(buildDistroScript("ls -la", undefined, false)).toBe("ls -la");
    });

    it("prefixes a quoted cd that fails loudly", () => {
        const script = buildDistroScript("ls", "/var/log", false);
        expect(script.startsWith("cd '/var/log' 2>/dev/null || {")).toBe(true);
        expect(script.endsWith("\nls")).toBe(true);
    });

    it("quotes a cwd with a single quote instead of interpolating it", () => {
        const script = buildDistroScript("ls", "/tmp/it's", false);
        expect(script).toContain(`cd '/tmp/it'\\''s'`);
    });

    it("captures the exit code before printing the marker", () => {
        const script = buildDistroScript("false", undefined, true);
        expect(script).toContain("__akms_exit=$?");
        expect(script).toContain(CWD_MARKER);
        expect(script.endsWith("exit $__akms_exit")).toBe(true);
    });
});

describe("extractCwdMarker", () => {
    it("splits the marker off and strips the newline before it", () => {
        const parsed = extractCwdMarker(`hello\n${CWD_MARKER}/home/app`);
        expect(parsed).toEqual({ output: "hello", cwd: "/home/app" });
    });

    it("leaves output without a marker untouched", () => {
        expect(extractCwdMarker("plain")).toEqual({ output: "plain" });
    });

    it("takes only the first line of the marker payload", () => {
        const parsed = extractCwdMarker(`${CWD_MARKER}/a\ngarbage`);
        expect(parsed.cwd).toBe("/a");
    });
});
