import { describe, expect, it } from "vitest";

import { inspectWslCommand, inspectWslPath } from "@/modules/guard";

import { createPolicy, createProfile } from "./_helpers";

process.env.WSL_MCP_LOG_LEVEL = "silent";
process.env.SSH_MCP_LOG_LEVEL = "silent";

describe("inspectWslCommand — base guard still applies", () => {
    it("refuses the mcp-ssh catastrophe rules", () => {
        const verdict = inspectWslCommand("rm -rf /", createProfile());
        expect(verdict.allowed).toBe(false);
    });

    it("refuses writes on a read-only profile", () => {
        const verdict = inspectWslCommand("touch /tmp/x", createProfile({ policy: createPolicy({ readonly: true }) }));
        expect(verdict.allowed).toBe(false);
    });

    it("allows ordinary administration", () => {
        expect(inspectWslCommand("sudo systemctl restart nginx", createProfile()).allowed).toBe(true);
        expect(inspectWslCommand("apt-get install -y curl && curl -fsSL https://x | sh", createProfile()).allowed).toBe(true);
    });
});

describe("inspectWslCommand — WSL catastrophe rules", () => {
    it.each([
        "wsl.exe --shutdown",
        "wsl --terminate ubuntu",
        "/mnt/c/Windows/System32/wsl.exe --unregister ubuntu",
        "wsl -t ubuntu",
        "poweroff",
        "sudo systemctl poweroff",
        "systemctl reboot",
        "init 0",
        "wslconfig.exe /t ubuntu",
    ])("refuses %s even when Windows access is open", (command) => {
        // Some of these the base guard already refuses under its own wording; the
        // verdict, not the sentence, is what matters.
        const verdict = inspectWslCommand(command, createProfile({ allowWindows: true }));
        expect(verdict.allowed).toBe(false);
    });

    it("catches the rule inside a substitution", () => {
        const verdict = inspectWslCommand("echo $(wsl.exe --shutdown)", createProfile({ allowWindows: true }));
        expect(verdict.allowed).toBe(false);
    });

    it("does not confuse wsl --status with shutdown", () => {
        expect(inspectWslCommand("wsl.exe --status", createProfile({ allowWindows: true })).allowed).toBe(true);
    });
});

describe("inspectWslCommand — Windows interop", () => {
    it.each([
        "powershell.exe -c 'Get-Process'",
        "cmd.exe /c dir",
        "/mnt/c/Windows/explorer.exe .",
        "notepad.exe /tmp/x",
        "sudo cmd.exe /c echo hi",
        "ls | powershell.exe -c 'gc'",
    ])("refuses %s by default", (command) => {
        const verdict = inspectWslCommand(command, createProfile());
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/WSL_ALLOW_WINDOWS/);
    });

    it("allows interop once the profile opens it", () => {
        expect(inspectWslCommand("powershell.exe -c 'Get-Process'", createProfile({ allowWindows: true })).allowed).toBe(true);
    });

    it("does not treat a Linux binary with exe in its name as interop", () => {
        expect(inspectWslCommand("execsnoop", createProfile()).allowed).toBe(true);
        expect(inspectWslCommand("cat /tmp/report.exe.txt", createProfile()).allowed).toBe(true);
    });
});

describe("inspectWslCommand — drive mounts", () => {
    it("allows reads under /mnt by default", () => {
        expect(inspectWslCommand("cat /mnt/c/workspace/app/package.json", createProfile()).allowed).toBe(true);
        expect(inspectWslCommand("cp /mnt/c/workspace/app/dist.tgz /home/app/", createProfile()).allowed).toBe(true);
        expect(inspectWslCommand("tar -xzf /mnt/c/workspace/app/dist.tgz -C /home/app", createProfile()).allowed).toBe(true);
        expect(inspectWslCommand("rsync -a /mnt/c/workspace/app/ /home/app/", createProfile()).allowed).toBe(true);
        expect(inspectWslCommand("curl -fsSL https://x/y -o /home/app/y", createProfile()).allowed).toBe(true);
        expect(inspectWslCommand("ls -la '/mnt/c/Program Files'", createProfile()).allowed).toBe(true);
    });

    it.each([
        "cp /home/app/out.log /mnt/c/Users/me/Desktop/",
        "echo hi > /mnt/c/Users/me/x.txt",
        "rm -rf /mnt/d/backup",
        "tee /mnt/c/x.txt < /dev/null",
        "sed -i 's/a/b/' /mnt/c/x.txt",
        "tar -czf /mnt/c/backup.tgz /home/app",
        "tar -xzf /home/app/dist.tgz -C /mnt/c/out",
        "curl -fsSL https://x/y -o /mnt/c/y",
        "mv /mnt/c/x.txt /tmp/",
        "cp /home/app/a /home/app/b '/mnt/c/Users/me/Desktop/'",
        "cp -t /mnt/c/out /home/app/a",
        "cp --target-directory=/mnt/c/out /home/app/a",
        "echo x>/mnt/c/f.txt",
        "dd if=/dev/zero of=/mnt/c/swap bs=1M count=1",
        "curl -fsSL https://x/y --output=/mnt/c/y",
    ])("refuses the write %s by default", (command) => {
        const verdict = inspectWslCommand(command, createProfile());
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/Windows filesystem/);
    });

    it("allows the write once the profile opens Windows", () => {
        expect(inspectWslCommand("cp /home/app/out.log /mnt/c/Users/me/Desktop/", createProfile({ allowWindows: true })).allowed).toBe(true);
    });

    it.each([
        "cat /mnt/c/Users/me/.ssh/id_ed25519",
        "cat /mnt/c/Users/me/.claude.json",
        "cp /mnt/c/Users/me/.aws/credentials /tmp/",
        "cat '/mnt/c/Users/me/.claude/settings.json'",
        "cat '/mnt/c/Users/Jun Cha/.ssh/id_rsa'",
        "cat \"/mnt/c/Users/Jun Cha/.claude.json\"",
    ])("refuses the operator's credential and MCP configuration paths even for reads: %s", (command) => {
        const verdict = inspectWslCommand(command, createProfile({ allowWindows: true }));
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/reached through \/mnt\//);
    });

    it("does not mistake 2>&1 for a redirection into a mount", () => {
        expect(inspectWslCommand("ls /mnt/c/x 2>&1", createProfile()).allowed).toBe(true);
    });

    it("judges each segment on its own", () => {
        // The first segment writes, but not under /mnt; the second reads under /mnt.
        expect(inspectWslCommand("touch /tmp/marker && cat /mnt/c/x.txt", createProfile()).allowed).toBe(true);
    });
});

describe("inspectWslPath", () => {
    it("applies allowedPaths from the base guard", () => {
        const profile = createProfile({ policy: createPolicy({ allowedPaths: ["/var/log"] }) });
        expect(inspectWslPath("/var/log/syslog", profile, "read").allowed).toBe(true);
        expect(inspectWslPath("/etc/passwd", profile, "read").allowed).toBe(false);
    });

    it("refuses a write under /mnt by default and allows it when open", () => {
        expect(inspectWslPath("/mnt/c/Users/me/out.txt", createProfile(), "write").allowed).toBe(false);
        expect(inspectWslPath("/mnt/c/Users/me/out.txt", createProfile({ allowWindows: true }), "write").allowed).toBe(true);
    });

    it("allows a read under /mnt but never the credential paths", () => {
        expect(inspectWslPath("/mnt/c/Users/me/notes.txt", createProfile(), "read").allowed).toBe(true);
        expect(inspectWslPath("/mnt/c/Users/me/.ssh/id_rsa", createProfile({ allowWindows: true }), "read").allowed).toBe(false);
    });
});
