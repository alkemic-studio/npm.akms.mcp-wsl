# Development

Sibling of [`@akms/mcp-ssh`](https://github.com/akms) — same layout, same build, same tool surface with `ssh_` → `wsl_`. The design record with the measurements behind each decision is `akms.docs/mcp-wsl-design.md`.

## 🧑‍💻 Commands

```bash
npm run dev -- --check   # tsx, straight from src
npm run build            # tsc --noEmit → tsup (esm + cjs + dts into lib/)
npm test                 # vitest, unit tests only
MCP_WSL_TEST_DISTRO=ubuntu MCP_WSL_TEST_USER=root npm test   # + live tests against a real distro
```

## 🗂️ Layout

```
src/
├── _defs/       constants, WSL rule tables, env var names
├── _types/      config / wsl types (compile-time only)
├── _libs/       stderr logger, text + path helpers
├── modules/
│   ├── config/  WSL_* readers, profile builder
│   ├── guard/   the WSL additions over @akms/mcp-ssh's guard
│   ├── wsl/     wsl.exe process runner, session manager, file operations, distro status
│   └── tools/   MCP tool registration, output formatting
├── server.ts    createWslMcpServer()
├── cli.ts       bin entry (stdio transport, --check)
└── index.ts     library entry
```

## 🏗️ Design decisions

### What is reused from @akms/mcp-ssh and what is not

Reused as a dependency: `inspectCommand`, `inspectRemotePath`, `inspectLocalPath`, `inspectWorkingDirectory`, `canonicalizeCommand`, the segment analysis helpers, `GuardRejectionError`, and the `SshPolicy` type (as `WslPolicy`, with `connectTimeoutMs` carried as 0). Two servers that refuse different things would need two sets of agent instructions.

Re-implemented: the `cd` wrapper and `$PWD` marker (not exported by mcp-ssh), the logger (its own env var), the text helpers. Written fresh: everything that touched ssh2.

Importing `@akms/mcp-ssh` loads `ssh2` as a side effect of its barrel. It is never used; it is the cost of not extracting a `@akms/mcp-guard` package yet.

### `--exec`, measured

Probing `wsl.exe` on 2026-09-28 gave the rules the runner is built on:

| | `-- bash -lc SCRIPT` | `--exec bash -lc SCRIPT` |
|---|---|---|
| `'x\y'` | `xy` | `x\y` |
| `"$HOME"` | expanded **before** bash ran | reaches bash as written |
| login shell | yes | yes (`bash -l`) |

`--` is the distro's default shell re-parsing the arguments. `--exec` is execve. Only the second lets the guard's view of the command be the command that runs.

Also measured: `--cd /missing` exits **0** and runs in `/` with a warning on stderr — so `cd` is done inside the script, where a missing directory exits 1. An unknown distro exits `4294967295` with the reason on **stdout** (localised); `WSL_UTF8=1` makes that stdout UTF-8 instead of UTF-16. `sudo -n` without `NOPASSWD` fails in milliseconds. A background job whose descriptors stay attached holds `wsl.exe` open; `nohup … > log 2>&1 < /dev/null &` returns in 100 ms.

### Guards live at the chokepoint

`WslHost.exec` screens every command; the file operations screen every path. Tool handlers never call a guard directly, so a new tool cannot forget to.

### The one default that differs: `WSL_ALLOW_WINDOWS`

mcp-ssh is permissive by default because a guard that blocks real work gets switched off wholesale. That still holds here — except for the two routes that leave the distro for Windows, because in WSL the machine on the other side is the one running this server, and the MCP configuration that defines the guard sits on its filesystem. Locking those two routes by default costs almost nothing (reads under `/mnt` stay open, so "deploy the file I built on Windows" works) and removes the one way a mistaken agent could rewrite its own policy.

The `/mnt` write rule judges the write **target**, not the mention: `cp /mnt/c/app/dist.tgz /home/app/` is a read of the mount and passes; `cp /home/app/out.log /mnt/c/Users/me/Desktop/` is refused. Per binary shape: copy-likes write their last operand, `tar` writes when creating, `curl -o` / `unzip -d` / `tar -C` write where the option points, every other write-shaped binary writes each operand, and a redirection is a target for any binary.

### Sessions are a remembered directory

Each call is its own process, so there is nothing to keep open. A session serializes its calls (the directory is read-modify-write) and adopts the `$PWD` the marker reports, after the same metacharacter check a caller-supplied `cwd` gets.

## 🧪 Testing

| File | Covers |
|---|---|
| `wsl-guard.test.ts` | WSL catastrophe rules, interop, `/mnt` write targets vs reads, operator paths through the mount, path guard |
| `host-profile.test.ts` | `WSL_*` mapping, defaults, malformed values |
| `wsl-command.test.ts` | Argument vector (`--exec`), `cd` wrapper, cwd marker |
| `live-integration.test.ts` | **MCP client ↔ server ↔ real distro** over an in-memory transport: exit codes, argument bytes, UTF-8, closed stdin, bad cwd, session `cd`, timeout, guard rejections proving nothing ran, file round-trips including binary upload/download, unknown distro |

The live file is skipped unless `MCP_WSL_TEST_DISTRO` names an installed distro on a Windows machine. It creates and removes `/tmp/akms-mcp-wsl-test-<pid>` in that distro.

## 📚 Embedding as a library

```typescript
import { createWslMcpServer } from "@akms/mcp-wsl";

const instance = createWslMcpServer();      // reads WSL_* from this process's environment
await instance.server.connect(myTransport);
instance.shutdown();
```

`WslHost`, `inspectWslCommand`, `inspectWslPath`, `loadHostProfile` and `registerAllTools` are importable on their own.

## 📦 Releasing

Bump `version` in `package.json` and `SERVER_VERSION` in `src/_defs/defaults.ts` together, add the entry to `CHANGELOG.md`, then `npm run build && npm publish`.
