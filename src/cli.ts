#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { LOG_LEVEL_ENV, SERVER_NAME, SERVER_VERSION, SINGLE_HOST_ENV } from "@/_defs";
import { $logger } from "@/_libs";
import type { WslHostProfile } from "@/_types";
import { WslHost, probeDistroFacts, queryDistroListing } from "@/modules/wsl";
import { formatDistroStatus } from "@/modules/tools";
import { createWslMcpServer } from "@/server";

/** `@akms/mcp-ssh`'s guard logs through its own logger; keep the two thresholds aligned. */
const SSH_LOG_LEVEL_ENV = "SSH_MCP_LOG_LEVEL";

interface CliArguments {
    showHelp: boolean;
    showVersion: boolean;
    checkOnly: boolean;
}

function parseArguments(argv: string[]): CliArguments {
    const parsed: CliArguments = { showHelp: false, showVersion: false, checkOnly: false };

    for (const argument of argv) {
        if (argument === "--help" || argument === "-h") {
            parsed.showHelp = true;
            continue;
        }

        if (argument === "--version" || argument === "-v") {
            parsed.showVersion = true;
            continue;
        }

        if (argument === "--check") {
            parsed.checkOnly = true;
            continue;
        }
    }

    return parsed;
}

const HELP_TEXT = [
    `${SERVER_NAME} ${SERVER_VERSION} — MCP server for command execution and file transfer in a WSL distro (via wsl.exe)`,
    "",
    "Usage:",
    "  akms-mcp-wsl [--check]",
    "",
    "Options:",
    "      --check          Look up the configured distro, run 'id' in it, report the result, and exit.",
    "  -v, --version        Print the version and exit",
    "  -h, --help           Print this help and exit",
    "",
    "Environment — one server entry per distro and user, set in the MCP client's env block:",
    `  ${SINGLE_HOST_ENV.DISTRO}          Distro name as 'wsl -l -q' prints it  (required)`,
    `  ${SINGLE_HOST_ENV.USER}            Linux user to run as; the distro default when unset`,
    `  ${SINGLE_HOST_ENV.NAME}            Alias shown to the model; defaults to the distro name`,
    `  ${SINGLE_HOST_ENV.DESCRIPTION}     Shown to the model — say what the distro is for`,
    `  ${SINGLE_HOST_ENV.CWD}             Directory new sessions start in`,
    `  ${SINGLE_HOST_ENV.READONLY}        Reject write commands, redirections, uploads  (default false)`,
    `  ${SINGLE_HOST_ENV.ALLOW_SUDO}      Allow sudo / su / doas  (default true)`,
    `  ${SINGLE_HOST_ENV.ALLOW_WINDOWS}   Allow interop .exe and writes under /mnt/<drive>/  (default false)`,
    `  ${SINGLE_HOST_ENV.ALLOW_COMMANDS}  Comma-separated allow-list of binaries`,
    `  ${SINGLE_HOST_ENV.DENY_PATTERNS}   Comma-separated extra deny regexes`,
    `  ${SINGLE_HOST_ENV.ALLOWED_PATHS}   Comma-separated path prefixes the file tools may touch`,
    `  ${SINGLE_HOST_ENV.EXEC_TIMEOUT_MS} / ${SINGLE_HOST_ENV.MAX_OUTPUT_CHARACTERS} / ${SINGLE_HOST_ENV.MAX_READ_FILE_BYTES}`,
    `  ${LOG_LEVEL_ENV}  silent | debug | info | warn | error  (default: info, written to stderr)`,
    "",
    "Windows only — wsl.exe is the transport. The server speaks MCP over stdio; run it from an MCP client, not interactively.",
].join("\n");

/**
 * Looks the distro up, runs `id` in it, and reports what happened.
 *
 * Without this the only way to find out whether the setup works is to ask an agent to try
 * something, which mixes a setup mistake up with a policy rejection. Writes to stdout
 * because this mode is not an MCP session.
 *
 * @returns Process exit code: 0 when the distro answers.
 */
async function runDistroCheck(profile: WslHostProfile | null): Promise<number> {
    if (profile == null) {
        process.stdout.write(`No WSL distro is registered — set ${SINGLE_HOST_ENV.DISTRO} (and optionally ${SINGLE_HOST_ENV.USER}).\n`);
        return 1;
    }

    const endpoint = `${profile.username ?? "(distro default)"}@${profile.distro}`;
    process.stdout.write(`Checking ${profile.name}  →  ${endpoint}\n\n`);

    let listing;
    try {
        listing = await queryDistroListing(profile.distro);
    }
    catch (ex) {
        let detail = String(ex);
        if (ex instanceof Error) {
            detail = ex.message;
        }
        process.stdout.write(`  FAILED  wsl.exe could not be started: ${detail}\n`);
        return 1;
    }

    if (listing.installed == false) {
        process.stdout.write(`  FAILED  ${formatDistroStatus(listing)}\n`);
        return 1;
    }

    const host = new WslHost(profile);
    const startedAt = Date.now();

    try {
        const probe = await host.exec({
            command: "id",
            timeoutMs: profile.policy.execTimeoutMs,
            maxOutputCharacters: profile.policy.maxOutputCharacters,
            trackCwd: false,
        });
        const durationMs = Date.now() - startedAt;

        if (probe.exitCode !== 0) {
            process.stdout.write(`  FAILED  ${endpoint}  exit code ${probe.exitCode}\n          ${probe.stderr.trim()}\n`);
            return 1;
        }

        const facts = await probeDistroFacts(host);
        process.stdout.write(`  OK      ${probe.stdout.trim()}  (${durationMs}ms)\n`);
        process.stdout.write(`          ${formatDistroStatus({ ...listing, ...facts })}\n`);
        return 0;
    }
    catch (ex) {
        let detail = String(ex);
        if (ex instanceof Error) {
            detail = ex.message;
        }
        process.stdout.write(`  FAILED  ${endpoint}\n          ${detail}\n`);
        return 1;
    }
}

async function main(): Promise<void> {
    const _logger = $logger.child({ context: "cli" });

    const cliArguments = parseArguments(process.argv.slice(2));

    if (cliArguments.showHelp == true) {
        process.stderr.write(`${HELP_TEXT}\n`);
        return;
    }

    if (cliArguments.showVersion == true) {
        process.stderr.write(`${SERVER_VERSION}\n`);
        return;
    }

    // `--check` prints a report a person reads; interleaved log lines make it unreadable.
    // An explicit level still wins, so `WSL_MCP_LOG_LEVEL=debug --check` stays available.
    if (cliArguments.checkOnly == true && process.env[LOG_LEVEL_ENV] == null) {
        process.env[LOG_LEVEL_ENV] = "silent";
    }

    if (process.env[SSH_LOG_LEVEL_ENV] == null && process.env[LOG_LEVEL_ENV] != null) {
        process.env[SSH_LOG_LEVEL_ENV] = process.env[LOG_LEVEL_ENV];
    }

    const instance = createWslMcpServer();

    if (cliArguments.checkOnly == true) {
        const exitCode = await runDistroCheck(instance.profile);
        instance.shutdown();
        process.exit(exitCode);
    }

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
        if (shuttingDown == true) {
            return;
        }
        shuttingDown = true;

        _logger.info("shutting down", { signal: signal });
        instance.shutdown();
        void instance.server.close().finally(() => {
            process.exit(0);
        });
    };

    process.on("SIGINT", () => {
        shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
        shutdown("SIGTERM");
    });

    // stdin closing means the MCP client is gone; without this the process would linger.
    process.stdin.on("close", () => {
        shutdown("stdin-close");
    });

    const transport = new StdioServerTransport();
    await instance.server.connect(transport);

    _logger.info("mcp server ready on stdio", {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        profile: instance.profile?.name ?? null,
    });
}

main().catch((error: unknown) => {
    const _logger = $logger.child({ context: "cli" });
    _logger.error(error, "mcp server failed to start");

    // Printed independently of the logger: `--check` silences it, and a setup mistake
    // that exits 1 with no explanation is the worst possible first-run experience.
    let detail = String(error);
    if (error instanceof Error) {
        detail = error.message;
    }

    process.stderr.write(`akms-mcp-wsl: ${detail}\n`);
    process.exit(1);
});
