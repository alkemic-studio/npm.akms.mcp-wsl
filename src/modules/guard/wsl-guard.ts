import {
    analyzeSegment,
    extractSubstitutions,
    inspectCommand,
    inspectLocalPath,
    inspectRemotePath,
    splitCommandSegments,
} from "@akms/mcp-ssh";
import type { RemotePathAccess, SegmentAnalysis } from "@akms/mcp-ssh";

import { MOUNT_PATH_PATTERN, WINDOWS_INTEROP_BINARY_PATTERN, WSL_CATASTROPHE_RULES } from "@/_defs";
import { mountPathToWindows } from "@/_libs";
import type { GuardVerdict, WslHostProfile, WslPolicy } from "@/_types";

/** Nested `$(…)` levels the WSL-specific pass descends into; matches the base guard's own limit. */
const MAX_INSPECTION_DEPTH = 5;

/**
 * Screens a command for a WSL host: the `@akms/mcp-ssh` guard first (catastrophe rules,
 * read-only, sudo, allow-list, deny patterns), then what only matters here.
 *
 * The WSL additions exist because one assumption of the base guard does not hold: that
 * the remote account is the real boundary. In WSL the "remote" is the machine running
 * this server. Through interop (`powershell.exe`) or a write under `/mnt/c/Users/…`, a
 * mistaken agent can reach `~/.claude.json` — the file that defines this very guard — so
 * both routes are closed unless `WSL_ALLOW_WINDOWS` opens them, and the operator's
 * credential and configuration paths stay closed either way.
 *
 * Flow:
 *  1) Base guard on the whole command
 *  2) Per segment (and per `$(…)` substitution, recursively): WSL catastrophe rules
 *  3) Per segment: interop binary
 *  4) Per segment: `/mnt/<drive>/` references — write shape, then protected Windows paths
 */
export function inspectWslCommand(canonicalCommand: string, profile: WslHostProfile, depth = 0): GuardVerdict {
    // (1) Base guard
    if (depth === 0) {
        const baseVerdict = inspectCommand(canonicalCommand, profile.policy);
        if (baseVerdict.allowed == false) {
            return baseVerdict;
        }
    }

    if (depth > MAX_INSPECTION_DEPTH) {
        return {
            allowed: false,
            reason: `command nests substitutions deeper than ${MAX_INSPECTION_DEPTH} levels`,
            offendingText: canonicalCommand,
        };
    }

    for (const substitution of extractSubstitutions(canonicalCommand)) {
        const nestedVerdict = inspectWslCommand(substitution, profile, depth + 1);
        if (nestedVerdict.allowed == false) {
            return nestedVerdict;
        }
    }

    for (const segment of splitCommandSegments(canonicalCommand)) {
        const analysis = analyzeSegment(segment);

        // (2) Catastrophe — never configurable, same stance as the base rules.
        for (const rule of WSL_CATASTROPHE_RULES) {
            if (rule.pattern.test(analysis.normalizedText) == true) {
                return { allowed: false, reason: rule.reason, offendingText: segment.trim() };
            }
        }

        // (3) Interop
        if (profile.allowWindows == false && WINDOWS_INTEROP_BINARY_PATTERN.test(analysis.binary) == true) {
            return {
                allowed: false,
                reason: `'${analysis.binary}' is a Windows executable: interop leaves the distro for the machine running this server (set WSL_ALLOW_WINDOWS=true to permit it)`,
                offendingText: segment.trim(),
            };
        }

        // (4) Drive mounts
        const mountPaths = collectMountPaths(segment, analysis);
        if (mountPaths.length === 0) {
            continue;
        }

        const writeShaped = isWriteShaped(segment, profile.policy);
        if (profile.allowWindows == false && writeShaped == true) {
            const mountTarget = findMountWriteTarget(segment, analysis);
            if (mountTarget != null) {
                return {
                    allowed: false,
                    reason: `writing to ${mountTarget} lands on the Windows filesystem of the machine running this server (set WSL_ALLOW_WINDOWS=true to permit writes under /mnt/<drive>/; reads and copies out of it are already allowed)`,
                    offendingText: segment.trim(),
                };
            }
        }

        let access: RemotePathAccess = "read";
        if (writeShaped == true) {
            access = "write";
        }

        for (const mountPath of mountPaths) {
            const protectedVerdict = inspectMountPath(mountPath, access);
            if (protectedVerdict.allowed == false) {
                return protectedVerdict;
            }
        }
    }

    return { allowed: true };
}

/**
 * Decides whether a file tool may touch a path in the distro: the base path guard
 * (`allowedPaths`, read-only), then the Windows rules for anything under `/mnt/<drive>/`.
 */
export function inspectWslPath(distroPath: string, profile: WslHostProfile, access: RemotePathAccess): GuardVerdict {
    const baseVerdict = inspectRemotePath(distroPath, profile.policy, access);
    if (baseVerdict.allowed == false) {
        return baseVerdict;
    }

    if (mountPathToWindows(distroPath) == null) {
        return { allowed: true };
    }

    if (access === "write" && profile.allowWindows == false) {
        return {
            allowed: false,
            reason: "writes under /mnt/<drive>/ land on the Windows filesystem of the machine running this server (set WSL_ALLOW_WINDOWS=true to permit them)",
            offendingText: distroPath.trim(),
        };
    }

    return inspectMountPath(distroPath.trim(), access);
}

/**
 * Applies `@akms/mcp-ssh`'s local-path protection to a `/mnt/<drive>/` path by translating
 * it to the Windows path it is — the same credential and MCP-configuration rules, the
 * same symlink resolution, so the two servers refuse the same files.
 */
function inspectMountPath(distroPath: string, access: RemotePathAccess): GuardVerdict {
    const windowsPath = mountPathToWindows(distroPath);
    if (windowsPath == null) {
        return { allowed: true };
    }

    const verdict = inspectLocalPath(windowsPath, access);
    if (verdict.allowed == true) {
        return verdict;
    }

    return {
        allowed: false,
        reason: `${verdict.reason} (reached through ${distroPath})`,
        offendingText: distroPath,
    };
}

/** Binaries whose write lands on their *last* operand only; earlier operands are sources. */
const DESTINATION_LAST_BINARIES = new Set(["cp", "rsync", "install", "scp"]);

/** Binaries that write where an option says, not where an operand is. */
const DESTINATION_BY_OPTION: Record<string, RegExp> = {
    tar: /^(?:-C|--directory)$/,
    unzip: /^-d$/,
    curl: /^(?:-o|--output)$/,
    wget: /^(?:-O|--output-document)$/,
};

/** `tar` creates or appends an archive — then the `f` operand is the write target. */
const TAR_CREATE_FLAG_PATTERN = /^(?:-[a-zA-Z]*[cru][a-zA-Z]*|--create|--append|--update|--concatenate|--delete)$/;

/**
 * The `/mnt/<drive>/` path a write-shaped segment would write *to*, or null when it only
 * reads from the mount.
 *
 * "Mentions /mnt and is a write" was the first rule and it refused the commonest legitimate
 * case — `cp /mnt/c/app/dist.tgz /home/app/`, deploying a file built on Windows. So the
 * target is worked out per binary shape: copy-likes write their last operand, archivers
 * and downloaders write where an option points, and everything else write-shaped (`rm`,
 * `sed -i`, `mv`, `tee`, `chmod`…) writes every operand. Output redirection is a write
 * target for any binary.
 */
function findMountWriteTarget(segment: string, analysis: SegmentAnalysis): string | null {
    for (const redirectionTarget of collectRedirectionTargets(segment)) {
        if (isMountPath(redirectionTarget) == true) {
            return redirectionTarget;
        }
    }

    const binary = analysis.binary.toLowerCase();
    let candidates: string[] = analysis.operands;

    if (DESTINATION_LAST_BINARIES.has(binary) == true) {
        // `cp -t DIR src…` puts the destination first.
        candidates = [...analysis.operands.slice(-1), ...valuesAfterOption(analysis.tokens, TARGET_DIRECTORY_OPTION)];
    }
    else if (binary === "tar") {
        const creating = analysis.flags.some((flag) => TAR_CREATE_FLAG_PATTERN.test(flag) == true);
        if (creating == false) {
            candidates = valuesAfterOption(analysis.tokens, DESTINATION_BY_OPTION.tar);
        }
    }
    else if (DESTINATION_BY_OPTION[binary] != null) {
        candidates = valuesAfterOption(analysis.tokens, DESTINATION_BY_OPTION[binary]);
    }

    // `--output=/mnt/c/y`, `--target-directory=/mnt/c/out`, `--directory=/mnt/c/out`: the
    // value rides inside the flag, whatever the binary.
    candidates = [...candidates, ...valuesInFlags(analysis.flags)];

    for (const candidate of candidates) {
        if (isMountPath(candidate) == true) {
            return candidate;
        }
    }

    return null;
}

/** `cp` / `install` / `mv` destination given ahead of the sources. */
const TARGET_DIRECTORY_OPTION = /^(?:-t|--target-directory)$/;

/** The `X` of `--flag=X` for every flag carrying a value — `--output=/mnt/c/x`, `--target-directory=/mnt/c/out`. */
function valuesInFlags(flags: string[]): string[] {
    const values: string[] = [];
    for (const flag of flags) {
        const separator = flag.indexOf("=");
        if (separator > 0) {
            values.push(flag.slice(separator + 1));
        }
    }

    return values;
}

/** Tokens that follow an option matching `optionPattern`, e.g. the `X` of `-C X`. */
function valuesAfterOption(tokens: string[], optionPattern: RegExp): string[] {
    const values: string[] = [];
    for (let index = 0; index < tokens.length - 1; index++) {
        if (optionPattern.test(tokens[index]) == true) {
            values.push(tokens[index + 1]);
        }
    }

    return values;
}

/**
 * Targets of `>`, `>>`, `&>`, `2>` in one segment, quotes stripped. No character is
 * required before the `>` — `echo x>/mnt/c/f` is as much a redirection as `echo x > f`.
 * `2>&1` is skipped because the target class excludes `&`.
 */
function collectRedirectionTargets(segment: string): string[] {
    const targets: string[] = [];
    for (const match of segment.matchAll(/>{1,2}\s*(['"]?)([^\s'"|;&<>]+)/g)) {
        targets.push(match[2]);
    }

    return targets;
}

/** Strips surrounding quotes and a `key=` prefix (`dd of=/mnt/c/x`, `'/mnt/c/a b'`). */
function bareCandidate(candidate: string): string {
    return candidate.replace(/^['"]|['"]$/g, "").replace(/^[A-Za-z_][\w-]*=/, "");
}

/** True for `/mnt/<drive>` or below. */
function isMountPath(candidate: string): boolean {
    return /^\/mnt\/[a-z](?:\/|$)/i.test(bareCandidate(candidate));
}

/**
 * Every `/mnt/<drive>/…` reference in one segment.
 *
 * The analysed tokens come first because they keep a quoted path whole — the raw regex
 * stops at the first space, so `'/mnt/c/Users/Jun Cha/.ssh/id_rsa'` would have been seen
 * as `/mnt/c/Users/Jun` and the credential rule never reached. The raw scan stays as the
 * net for whatever the tokenizer did not classify.
 */
function collectMountPaths(segment: string, analysis: SegmentAnalysis): string[] {
    const found = new Set<string>();

    const candidates = [
        ...analysis.operands,
        ...valuesInFlags(analysis.flags),
        ...collectRedirectionTargets(segment),
    ];
    for (const candidate of candidates) {
        if (isMountPath(candidate) == true) {
            found.add(bareCandidate(candidate));
        }
    }

    for (const match of segment.matchAll(MOUNT_PATH_PATTERN)) {
        found.add(match[0]);
    }

    return Array.from(found);
}

/**
 * True when the base guard's read-only rules would refuse the segment — the same
 * definition of "a write" that `WSL_READONLY` uses, so the two never disagree.
 */
function isWriteShaped(segment: string, policy: WslPolicy): boolean {
    const readonlyPolicy: WslPolicy = { ...policy, readonly: true };
    const verdict = inspectCommand(segment, readonlyPolicy);
    return verdict.allowed == false;
}
