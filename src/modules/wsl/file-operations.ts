import fs from "node:fs";
import path from "node:path";

import { MAX_DIRECTORY_ENTRIES } from "@/_defs";
import { quoteShellArgument } from "@/_libs";
import type { WslDirectoryEntry } from "@/_types";
import { GuardRejectionError, inspectWslPath } from "@/modules/guard";
import type { RemotePathAccess } from "@/modules/guard";

import type { WslHost, WslProcessOutput } from "./wsl-host";

/** Bytes a fixed script may print before it is cut off — listings and stat output, never file content. */
const METADATA_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface DirectoryListing {
    entries: WslDirectoryEntry[];
    /** Entries the distro reported, before the cap was applied. */
    totalCount: number;
    truncated: boolean;
}

export interface FileContent {
    content: string;
    /** Size `stat` reported; 0 for virtual files that do not declare one. */
    sizeBytes: number;
    /** Bytes actually read. */
    readBytes: number;
    truncated: boolean;
}

/**
 * The file operations run **fixed scripts** (`find`, `stat`, `head`, `cat`) with the
 * path single-quoted through `quoteShellArgument` — so they bypass the command guard,
 * exactly as SFTP bypasses it in `@akms/mcp-ssh`, and are governed by the path guard
 * (`allowedPaths`, read-only, the Windows-mount rules) instead. Two consequences worth
 * knowing: `WSL_ALLOW_COMMANDS` does not have to list `find` or `cat`, and a read-only
 * profile still refuses writes here because `inspectWslPath` checks `policy.readonly`.
 *
 * Content travels over the process's stdin / stdout, which are byte-clean pipes — the
 * `\\wsl$\` share was rejected because it opens files as the distro's default user,
 * not as the registered one.
 */
function requirePermittedPath(host: WslHost, distroPath: string, access: RemotePathAccess): void {
    const verdict = inspectWslPath(distroPath, host.profile, access);
    if (verdict.allowed == false) {
        throw new GuardRejectionError(verdict);
    }
}

/** Runs a fixed script and throws with its stderr when it failed — the file operations never return partial results. */
async function runFixedScript(host: WslHost, script: string, stdin?: Buffer | fs.ReadStream): Promise<Buffer> {
    const output = await host.runProcess({
        script: script,
        stdin: stdin,
        timeoutMs: host.profile.policy.execTimeoutMs,
        maxCapturedBytes: METADATA_CAPTURE_BYTES,
    });

    if (output.timedOut == true) {
        throw new Error(`timed out after ${host.profile.policy.execTimeoutMs}ms`);
    }

    if (output.exitCode !== 0) {
        const detail = output.stderr.toString("utf8").trim();
        throw new Error(detail === "" ? `exit code ${output.exitCode}` : detail);
    }

    return output.stdout;
}

const ENTRY_TYPES: Record<string, WslDirectoryEntry["type"]> = {
    f: "file",
    d: "directory",
    l: "symlink",
};

/**
 * Lists a directory, directories first then files, each group alphabetical, capped at
 * `MAX_DIRECTORY_ENTRIES`. One `find -printf` call; `%y` is the type letter, `%m` the
 * octal mode, `%s` bytes, `%T+` the mtime.
 */
export async function listDirectory(host: WslHost, distroPath: string): Promise<DirectoryListing> {
    requirePermittedPath(host, distroPath, "read");

    const quotedPath = quoteShellArgument(distroPath);
    const findPrefix = `find ${quotedPath} -mindepth 1 -maxdepth 1`;
    const script = [
        `test -d ${quotedPath} || { echo 'not a directory' >&2; exit 2; }`,
        // First line: the true entry count. The listing itself is bounded with `head`, so
        // a directory of a million files costs the distro a `find`, not this server 4 MB.
        `${findPrefix} -printf x | wc -c`,
        // One line per entry: type \t mode \t size \t mtime \t name. `-printf` never quotes,
        // and a name cannot contain a newline in any directory a tool should be listing.
        `${findPrefix} -printf '%y\\t%m\\t%s\\t%TY-%Tm-%TdT%TH:%TM:%.2TS\\t%f\\n' | head -n ${MAX_DIRECTORY_ENTRIES + 1}`,
    ].join("\n");

    const stdout = await runFixedScript(host, script);
    const [countLine, ...lines] = stdout.toString("utf8").split("\n").filter((line) => line !== "");
    const reportedCount = Number(countLine) || 0;

    const entries: WslDirectoryEntry[] = [];
    for (const line of lines) {
        const [typeLetter, mode, size, modifiedAt, ...nameParts] = line.split("\t");
        const name = nameParts.join("\t");
        if (name == null || name === "") {
            continue;
        }

        entries.push({
            name: name,
            type: ENTRY_TYPES[typeLetter] ?? "other",
            sizeBytes: Number(size) || 0,
            mode: `0${mode}`,
            modifiedAt: modifiedAt,
        });
    }

    entries.sort((left, right) => {
        if (left.type === "directory" && right.type !== "directory") {
            return -1;
        }
        if (left.type !== "directory" && right.type === "directory") {
            return 1;
        }
        return left.name.localeCompare(right.name);
    });

    const totalCount = Math.max(reportedCount, entries.length);
    const truncated = totalCount > MAX_DIRECTORY_ENTRIES;

    return {
        entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
        totalCount: totalCount,
        truncated: truncated,
    };
}

/**
 * Reads the leading `maxBytes` of a file. Two processes — `stat` for the declared size,
 * then `head -c` — because mixing a size line into the content stream would need
 * escaping that a fixed script should not have.
 */
export async function readFile(host: WslHost, distroPath: string, maxBytes: number): Promise<FileContent> {
    requirePermittedPath(host, distroPath, "read");

    const quotedPath = quoteShellArgument(distroPath);
    const statScript = [
        `test -e ${quotedPath} || { echo 'no such file' >&2; exit 2; }`,
        `test -d ${quotedPath} && { echo 'is a directory' >&2; exit 2; }`,
        `stat -c %s ${quotedPath}`,
    ].join("\n");
    const sizeBytes = Number((await runFixedScript(host, statScript)).toString("utf8").trim()) || 0;

    // One byte past the limit tells truncation apart from "exactly the limit" without a
    // second stat of a file that may have grown in between.
    const probeBytes = maxBytes + 1;
    const output = await host.runProcess({
        script: `head -c ${probeBytes} ${quotedPath}`,
        timeoutMs: host.profile.policy.execTimeoutMs,
        maxCapturedBytes: probeBytes,
    });

    if (output.exitCode !== 0 && output.capExceeded == false) {
        throw new Error(output.stderr.toString("utf8").trim() || `exit code ${output.exitCode}`);
    }

    const truncated = output.stdout.length > maxBytes;
    const kept = output.stdout.subarray(0, maxBytes);

    return {
        content: kept.toString("utf8"),
        sizeBytes: sizeBytes,
        readBytes: kept.length,
        truncated: truncated,
    };
}

/**
 * Writes or appends UTF-8 text. Content goes through stdin, so nothing in it is ever
 * shell-parsed; only the path is interpolated, quoted.
 *
 * @returns Bytes written.
 */
export async function writeFile(host: WslHost, args: { distroPath: string; content: string; append: boolean }): Promise<number> {
    const { distroPath, content, append } = args;

    requirePermittedPath(host, distroPath, "write");

    const payload = Buffer.from(content, "utf8");
    const quotedPath = quoteShellArgument(distroPath);

    let redirection = ">";
    if (append == true) {
        redirection = ">>";
    }

    await runFixedScript(host, `cat ${redirection} ${quotedPath}`, payload);
    return payload.length;
}

/**
 * Local → distro. The local file is streamed into the process's stdin, so size is bounded
 * by the distro's disk, not this server's memory.
 *
 * @returns Bytes sent, from the local file's size.
 */
export async function uploadFile(host: WslHost, localPath: string, distroPath: string): Promise<number> {
    requirePermittedPath(host, distroPath, "write");

    const localStats = fs.statSync(localPath);
    if (localStats.isFile() == false) {
        throw new Error(`local path is not a regular file: ${localPath}`);
    }

    const stream = fs.createReadStream(localPath);
    try {
        await runFixedScript(host, `cat > ${quoteShellArgument(distroPath)}`, stream);
    }
    finally {
        stream.destroy();
    }

    return localStats.size;
}

/**
 * Distro → local. stdout streams straight into the destination file, so a large download
 * never sits in memory. The destination's parent must already exist — the tool creates
 * no directories on the operator's machine.
 *
 * @returns Bytes received.
 */
export async function downloadFile(host: WslHost, distroPath: string, localPath: string): Promise<number> {
    requirePermittedPath(host, distroPath, "read");

    const parent = path.dirname(localPath);
    if (fs.existsSync(parent) == false) {
        throw new Error(`local directory does not exist: ${parent}`);
    }

    const quotedPath = quoteShellArgument(distroPath);
    const script = [
        `test -f ${quotedPath} || { echo 'not a regular file' >&2; exit 2; }`,
        `cat ${quotedPath}`,
    ].join("\n");

    const sink = fs.createWriteStream(localPath);
    let output: WslProcessOutput;
    try {
        output = await host.runProcess({
            script: script,
            stdoutSink: sink,
            timeoutMs: host.profile.policy.execTimeoutMs,
            maxCapturedBytes: METADATA_CAPTURE_BYTES,
        });

        if (output.timedOut == true) {
            throw new Error(`timed out after ${host.profile.policy.execTimeoutMs}ms; the partial file was removed`);
        }

        if (output.exitCode !== 0) {
            throw new Error(output.stderr.toString("utf8").trim() || `exit code ${output.exitCode}`);
        }
    }
    catch (ex) {
        // Whatever failed — the distro, wsl.exe itself, the timeout — a half-written or
        // empty destination must not be left looking like a download.
        await new Promise<void>((resolve) => {
            sink.end(resolve);
        });
        fs.rmSync(localPath, { force: true });
        throw ex;
    }

    await new Promise<void>((resolve) => {
        sink.end(resolve);
    });

    return output.sinkBytes;
}
