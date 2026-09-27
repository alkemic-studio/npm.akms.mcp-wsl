import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { $logger } from "@/_libs";
import type { WslDistroStatus } from "@/_types";
import { probeDistroFacts, queryDistroListing } from "@/modules/wsl";

import { formatHostProfile } from "./format";
import { textResult, toToolError } from "./tool-context";
import type { ToolContext } from "./tool-context";

export function registerHostTools(server: McpServer, context: ToolContext): void {
    server.registerTool(
        "wsl_list_hosts",
        {
            title: "Show the WSL distro",
            description: [
                "Show the WSL distro and user this server runs commands in, with its guard policy and current state (running or stopped, WSL version, networking mode, whether systemd is PID 1).",
                "Call this first: it is the only reachable distro, and its policy decides what the other tools will accept.",
                "The networking mode matters when reasoning about ports — in mirrored mode a port Windows holds cannot be bound inside the distro, and a listing inside the distro shows only its own namespace.",
            ].join(" "),
            inputSchema: {},
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            const _logger = $logger.child({ context: "wsl_list_hosts" });

            try {
                const host = context.host;
                let status: WslDistroStatus | null = null;

                if (host != null) {
                    status = await queryDistroListing(host.profile.distro);

                    // The inside facts need the distro running; probing a stopped one would
                    // start it as a side effect of a "show me" call.
                    if (status.installed == true && status.state === "Running") {
                        const facts = await probeDistroFacts(host);
                        status = { ...status, ...facts };
                    }
                }

                const listing = formatHostProfile(host?.profile ?? null, status);
                _logger.debug("host profile returned", { profile: host?.profile.name, state: status?.state });
                return textResult(listing);
            }
            catch (ex) {
                return toToolError(ex, "wsl_list_hosts", "show the distro");
            }
        }
    );
}
