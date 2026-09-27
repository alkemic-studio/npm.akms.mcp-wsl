import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWslMcpServer } from "@/server";
import type { WslMcpServerInstance } from "@/server";

import { LIVE_DISTRO, LIVE_ENABLED, LIVE_USER } from "./_helpers";

process.env.WSL_MCP_LOG_LEVEL = "silent";
process.env.SSH_MCP_LOG_LEVEL = "silent";

/**
 * End-to-end through the real MCP layer into a real distro: a client calls tools over an
 * in-memory transport, the server runs its handlers, and `wsl.exe` runs the commands.
 * Skipped unless MCP_WSL_TEST_DISTRO names an installed distro (Windows only).
 *
 *     MCP_WSL_TEST_DISTRO=ubuntu MCP_WSL_TEST_USER=root npx vitest run
 */

let instance: WslMcpServerInstance;
let client: Client;
const scratchDirectory = `/tmp/akms-mcp-wsl-test-${process.pid}`;

function firstText(result: unknown): string {
    const typed = result as { content?: { type: string; text?: string }[] };
    return typed.content?.[0]?.text ?? "";
}

function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
}

async function exec(command: string, extra?: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: "wsl_exec", arguments: { command: command, ...extra } });
    return firstText(result);
}

describe.skipIf(LIVE_ENABLED == false)("live wsl.exe integration", () => {
    beforeAll(async () => {
        process.env.WSL_DISTRO = LIVE_DISTRO;
        process.env.WSL_USER = LIVE_USER;
        process.env.WSL_EXEC_TIMEOUT_MS = "20000";
        instance = createWslMcpServer();
        delete process.env.WSL_DISTRO;
        delete process.env.WSL_USER;
        delete process.env.WSL_EXEC_TIMEOUT_MS;

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await instance.server.connect(serverTransport);
        client = new Client({ name: "test", version: "0" });
        await client.connect(clientTransport);

        await exec(`mkdir -p ${scratchDirectory}`);
    }, 60_000);

    afterAll(async () => {
        if (client != null) {
            await exec(`rm -rf ${scratchDirectory}`);
            await client.close();
        }
        if (instance != null) {
            instance.shutdown();
        }
    });

    it("lists the distro with its state and networking mode", async () => {
        const text = firstText(await client.callTool({ name: "wsl_list_hosts", arguments: {} }));
        expect(text).toContain(`@${LIVE_DISTRO}`);
        expect(text).toMatch(/distro: (Running|Stopped)/);
        expect(text).toContain("windows=locked");
    });

    it("returns exit code, stdout and stderr separately, with argument bytes intact", async () => {
        const text = await exec(String.raw`printf '%s\n' 'x\y' "$HOME" '%PATH%'; echo err >&2; exit 3`);
        expect(text).toContain("exit code: 3");
        expect(text).toContain("x\\y");
        expect(text).toContain("%PATH%");
        expect(text).not.toContain("exit code: 0");
        expect(text).toMatch(/--- stderr ---\nerr/);
    });

    it("runs a login shell as the configured user", async () => {
        const text = await exec("id -un; shopt -q login_shell && echo login-yes");
        expect(text).toContain(LIVE_USER);
        expect(text).toContain("login-yes");
    });

    it("keeps utf-8 through the pipe", async () => {
        const text = await exec("echo '한글 😀'");
        expect(text).toContain("한글 😀");
    });

    it("closes stdin so a reading command does not hang", async () => {
        const text = await exec("read -r line; echo \"got=[$line]\"");
        expect(text).toContain("got=[]");
    });

    it("fails a bad cwd loudly instead of running in /", async () => {
        const text = await exec("pwd", { cwd: "/definitely/not/here" });
        expect(text).toContain("exit code: 1");
        expect(text).toContain("cannot enter the requested working directory");
    });

    it("remembers cd across session calls", async () => {
        const opened = firstText(await client.callTool({ name: "wsl_connect", arguments: { cwd: "/tmp" } }));
        const sessionId = /Opened session (\S+)/.exec(opened)?.[1];
        expect(sessionId).toBeDefined();

        await exec(`cd ${scratchDirectory}`, { session: sessionId });
        const text = await exec("pwd", { session: sessionId });
        expect(text).toContain(`cwd: ${scratchDirectory}`);
        expect(text).toContain(`\n${scratchDirectory}`);

        await client.callTool({ name: "wsl_disconnect", arguments: { session: sessionId } });
    });

    it("times out and reports it", async () => {
        const text = await exec("sleep 5", { timeoutMs: 800 });
        expect(text).toContain("TIMED OUT");
    }, 15_000);

    it("refuses interop and /mnt writes through the guard, running nothing", async () => {
        const interop = await client.callTool({ name: "wsl_exec", arguments: { command: "powershell.exe -c 'Get-Date'" } });
        expect(isError(interop)).toBe(true);
        expect(firstText(interop)).toContain("Nothing was run");

        const mountWrite = await client.callTool({ name: "wsl_exec", arguments: { command: "echo x > /mnt/c/akms-mcp-wsl-should-not-exist.txt" } });
        expect(isError(mountWrite)).toBe(true);
        expect(fs.existsSync("C:/akms-mcp-wsl-should-not-exist.txt")).toBe(false);

        const shutdown = await client.callTool({ name: "wsl_exec", arguments: { command: "wsl.exe --shutdown" } });
        expect(isError(shutdown)).toBe(true);
    });

    it("writes, reads, lists, uploads and downloads through the distro process", async () => {
        const filePath = `${scratchDirectory}/note's.txt`;
        const written = await client.callTool({ name: "wsl_write_file", arguments: { path: filePath, content: "line 1 \"quoted\" $HOME\n" } });
        expect(isError(written)).toBe(false);

        const appended = await client.callTool({ name: "wsl_write_file", arguments: { path: filePath, content: "line 2\n", append: true } });
        expect(isError(appended)).toBe(false);

        const read = firstText(await client.callTool({ name: "wsl_read_file", arguments: { path: filePath } }));
        expect(read).toContain("line 1 \"quoted\" $HOME\nline 2\n");

        const truncated = firstText(await client.callTool({ name: "wsl_read_file", arguments: { path: filePath, maxBytes: 4 } }));
        expect(truncated).toContain("truncated to the first 4 B");
        expect(truncated.endsWith("line")).toBe(true);

        const listing = firstText(await client.callTool({ name: "wsl_list_dir", arguments: { path: scratchDirectory } }));
        expect(listing).toContain("note's.txt");
        expect(listing).toMatch(/-  0\d{3}\s+\d+ B/);

        const localDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-mcp-wsl-"));
        const localSource = path.join(localDirectory, "binary.bin");
        const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13, 10, 0x41]);
        fs.writeFileSync(localSource, bytes);

        const uploaded = await client.callTool({ name: "wsl_upload", arguments: { localPath: localSource, remotePath: `${scratchDirectory}/binary.bin` } });
        expect(isError(uploaded)).toBe(false);

        const localTarget = path.join(localDirectory, "roundtrip.bin");
        const downloaded = await client.callTool({ name: "wsl_download", arguments: { remotePath: `${scratchDirectory}/binary.bin`, localPath: localTarget } });
        expect(isError(downloaded)).toBe(false);
        expect(Buffer.compare(fs.readFileSync(localTarget), bytes)).toBe(0);

        fs.rmSync(localDirectory, { recursive: true, force: true });
    }, 60_000);

    it("reports a missing file as a tool error, not as content", async () => {
        const result = await client.callTool({ name: "wsl_read_file", arguments: { path: `${scratchDirectory}/nope.txt` } });
        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("no such file");
    });
});

describe.skipIf(process.platform !== "win32")("unknown distro", () => {
    it("surfaces wsl.exe's own failure as a tool error", async () => {
        process.env.WSL_DISTRO = "akms-mcp-wsl-no-such-distro";
        const local = createWslMcpServer();
        delete process.env.WSL_DISTRO;

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await local.server.connect(serverTransport);
        const localClient = new Client({ name: "test", version: "0" });
        await localClient.connect(clientTransport);

        const result = await localClient.callTool({ name: "wsl_exec", arguments: { command: "id" } });
        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("wsl.exe failed for distro");

        await localClient.close();
        local.shutdown();
    }, 30_000);
});
