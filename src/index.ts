export { createWslMcpServer } from "./server";
export type { WslMcpServerInstance } from "./server";

export { loadHostProfile, toHostSummary } from "./modules/config";

export {
    WslHost,
    WslSession,
    WslSessionManager,
    buildWslArguments,
    buildDistroScript,
    extractCwdMarker,
    listDirectory,
    readFile,
    writeFile,
    uploadFile,
    downloadFile,
    queryDistroListing,
    probeDistroFacts,
} from "./modules/wsl";
export type { WslExecOptions, WslProcessOptions, WslProcessOutput, DirectoryListing, FileContent } from "./modules/wsl";

export { inspectWslCommand, inspectWslPath, GuardRejectionError } from "./modules/guard";

export { registerAllTools } from "./modules/tools";
export type { ToolContext } from "./modules/tools";

export { $logger } from "./_libs";
export type { Logger, LogLevel } from "./_libs";

export { SERVER_NAME, SERVER_VERSION, LOG_LEVEL_ENV, SINGLE_HOST_ENV } from "./_defs";

export type {
    WslPolicy,
    WslHostProfile,
    WslHostSummary,
    WslExecResult,
    WslSessionInfo,
    WslDirectoryEntry,
    WslDistroStatus,
    GuardVerdict,
} from "./_types";
