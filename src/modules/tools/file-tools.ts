import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { $logger, expandHomePath, formatBytes } from "@/_libs";
import { GuardRejectionError, inspectLocalPath } from "@/modules/guard";
import { downloadFile, listDirectory, readFile, uploadFile, writeFile } from "@/modules/wsl";

import { formatDirectoryListing } from "./format";
import { resolveHost, textResult, toToolError } from "./tool-context";
import type { ToolContext } from "./tool-context";

const SESSION_DESCRIPTION = "Session id from wsl_connect. Optional — the file tools do not depend on a session's working directory, paths are absolute.";

/**
 * Screens a path on the Windows side of this machine.
 *
 * The distro side is guarded inside the file operations, where the policy lives. The
 * Windows side has no policy — it is the operator's own filesystem — so it is checked
 * here, at the only layer that knows the path came from a tool argument. Same rules as
 * `@akms/mcp-ssh`: credentials and the files that define the guards.
 *
 * @throws {GuardRejectionError} If the path is protected.
 */
function requirePermittedLocalPath(localPath: string, access: "read" | "write"): void {
    const verdict = inspectLocalPath(localPath, access);
    if (verdict.allowed == false) {
        throw new GuardRejectionError(verdict);
    }
}

export function registerFileTools(server: McpServer, context: ToolContext): void {
    server.registerTool(
        "wsl_list_dir",
        {
            title: "List a directory in WSL",
            description: [
                "List a directory in the distro, with type, permissions, size and mtime.",
                "Cheaper and more structured than running 'ls -la' through wsl_exec, and it works on a read-only profile.",
            ].join(" "),
            inputSchema: {
                path: z.string().min(1).describe("Absolute directory path in the distro. When WSL_ALLOWED_PATHS is set, only paths inside it are accepted."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ path: distroPath, session }) => {
            const _logger = $logger.child({ context: "wsl_list_dir", distro_path: distroPath });

            try {
                const { host } = resolveHost(context, { session: session });
                const listing = await listDirectory(host, distroPath);

                _logger.info("directory listed", { entry_count: listing.totalCount, truncated: listing.truncated });
                return textResult(formatDirectoryListing(distroPath, listing));
            }
            catch (ex) {
                return toToolError(ex, "wsl_list_dir", `list ${distroPath}`);
            }
        }
    );

    server.registerTool(
        "wsl_read_file",
        {
            title: "Read a file in WSL",
            description: [
                "Read a text file in the distro and return its contents.",
                "Oversized files come back truncated to their leading bytes rather than failing, so pointing this at a large log is safe.",
                "Files that report size 0 but hold content (/proc, /sys) are read in full up to the ceiling.",
            ].join(" "),
            inputSchema: {
                path: z.string().min(1).describe("Absolute file path in the distro."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
                maxBytes: z.number().int().positive().optional().describe("Lowers the read ceiling for this call; it cannot exceed WSL_MAX_READ_BYTES."),
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ path: distroPath, session, maxBytes }) => {
            const _logger = $logger.child({ context: "wsl_read_file", distro_path: distroPath });

            try {
                const { host } = resolveHost(context, { session: session });

                // Clamped, not defaulted: an override above the profile ceiling would let one
                // call buffer hundreds of megabytes and take the server down.
                const requestedLimit = maxBytes ?? host.profile.policy.maxReadFileBytes;
                const readLimit = Math.min(requestedLimit, host.profile.policy.maxReadFileBytes);

                const file = await readFile(host, distroPath, readLimit);

                let header = `${distroPath} — ${formatBytes(file.readBytes)} read`;
                if (file.sizeBytes > 0) {
                    header = `${distroPath} — ${formatBytes(file.sizeBytes)}`;
                }

                if (file.truncated == true) {
                    header += `, truncated to the first ${formatBytes(file.readBytes)}`;
                }

                _logger.info("file read", { size_bytes: file.sizeBytes, read_bytes: file.readBytes, truncated: file.truncated });
                return textResult(`${header}\n\n${file.content}`);
            }
            catch (ex) {
                return toToolError(ex, "wsl_read_file", `read ${distroPath}`);
            }
        }
    );

    server.registerTool(
        "wsl_write_file",
        {
            title: "Write a file in WSL",
            description: [
                "Write or append UTF-8 text to a file in the distro. The content never passes through a shell, so quoting is not a concern.",
                "Prefer this over heredocs in wsl_exec. Parent directories must exist. Refused on a read-only profile, and under /mnt/<drive>/ unless the profile allows Windows writes.",
            ].join(" "),
            inputSchema: {
                path: z.string().min(1).describe("Absolute file path in the distro."),
                content: z.string().describe("Text to write."),
                append: z.boolean().optional().describe("Append instead of overwrite. Default false."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ path: distroPath, content, append, session }) => {
            const _logger = $logger.child({ context: "wsl_write_file", distro_path: distroPath });

            try {
                const { host } = resolveHost(context, { session: session });
                const written = await writeFile(host, { distroPath: distroPath, content: content, append: append ?? false });

                let verb = "Wrote";
                if (append == true) {
                    verb = "Appended";
                }

                _logger.info("file written", { bytes: written, append: append ?? false });
                return textResult(`${verb} ${formatBytes(written)} to ${distroPath}`);
            }
            catch (ex) {
                return toToolError(ex, "wsl_write_file", `write ${distroPath}`);
            }
        }
    );

    server.registerTool(
        "wsl_upload",
        {
            title: "Upload a file into WSL",
            description: [
                "Copy a file from this machine into the distro. The local path is resolved on the Windows side (a POSIX-looking path becomes <current drive>\\…), and the reply prints it — check it.",
                "Credential files and MCP configuration on the local side are refused.",
            ].join(" "),
            inputSchema: {
                localPath: z.string().min(1).describe("Path on this machine, '~' expanded."),
                remotePath: z.string().min(1).describe("Absolute destination path in the distro (the file, not its directory)."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ localPath, remotePath, session }) => {
            const resolvedLocalPath = expandHomePath(localPath);
            const _logger = $logger.child({ context: "wsl_upload", local_path: resolvedLocalPath, distro_path: remotePath });

            try {
                requirePermittedLocalPath(resolvedLocalPath, "read");

                const { host } = resolveHost(context, { session: session });
                const sent = await uploadFile(host, resolvedLocalPath, remotePath);

                _logger.info("file uploaded", { bytes: sent });
                return textResult(`Uploaded ${formatBytes(sent)}: ${resolvedLocalPath} → ${remotePath}`);
            }
            catch (ex) {
                return toToolError(ex, "wsl_upload", `upload ${resolvedLocalPath} to ${remotePath}`);
            }
        }
    );

    server.registerTool(
        "wsl_download",
        {
            title: "Download a file from WSL",
            description: [
                "Copy a file from the distro to this machine. The local path is resolved on the Windows side and printed in the reply — check it.",
                "The destination directory must already exist; credential locations and MCP configuration on the local side are refused.",
            ].join(" "),
            inputSchema: {
                remotePath: z.string().min(1).describe("Absolute source path in the distro."),
                localPath: z.string().min(1).describe("Destination path on this machine, '~' expanded."),
                session: z.string().optional().describe(SESSION_DESCRIPTION),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ remotePath, localPath, session }) => {
            const resolvedLocalPath = expandHomePath(localPath);
            const _logger = $logger.child({ context: "wsl_download", local_path: resolvedLocalPath, distro_path: remotePath });

            try {
                requirePermittedLocalPath(resolvedLocalPath, "write");

                const { host } = resolveHost(context, { session: session });
                const received = await downloadFile(host, remotePath, resolvedLocalPath);

                _logger.info("file downloaded", { bytes: received });
                return textResult(`Downloaded ${formatBytes(received)}: ${remotePath} → ${resolvedLocalPath}`);
            }
            catch (ex) {
                return toToolError(ex, "wsl_download", `download ${remotePath} to ${resolvedLocalPath}`);
            }
        }
    );
}
