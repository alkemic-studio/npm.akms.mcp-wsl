# @akms/mcp-wsl

> 🔒 Internal use only — built for our organization's services.

MCP server that lets an AI agent run shell commands and transfer files in a WSL distro **on this machine**, through `wsl.exe`.

No sshd in the distro, no key, no port, no networking mode to keep alive: the first call starts the distro if it is stopped, and the Linux user is one variable. The distro is **pre-registered** in the server's own environment; the agent never names a distro or a user, and no tool takes one. Every command and path is screened by the [`@akms/mcp-ssh`](https://www.npmjs.com/package/@akms/mcp-ssh) guard policy plus the rules that only a WSL host needs.

Windows only — the transport is `wsl.exe`. For reaching a WSL distro from *another* machine, keep using `@akms/mcp-ssh` against its sshd.

## 📦 Installation

```bash
npm install -g @akms/mcp-wsl   # installs the `akms-mcp-wsl` command
npx -y @akms/mcp-wsl --help    # or run it straight from the registry
```

## ⚙️ MCP client setup

**One server entry per distro and user** — plain `WSL_*` variables, no config file. Claude Code reads `.mcp.json` in the project or `~/.claude.json` globally; Claude Desktop takes the same block inside `claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "wsl_ubuntu_root": {
            "command": "npx",
            "args": ["-y", "@akms/mcp-wsl"],
            "env": { "WSL_DISTRO": "ubuntu", "WSL_USER": "root", "WSL_DESCRIPTION": "nginx, cloudflared and the test stack" }
        },
        "wsl_ubuntu_deploy": {
            "command": "npx",
            "args": ["-y", "@akms/mcp-wsl"],
            "env": { "WSL_DISTRO": "ubuntu", "WSL_USER": "deploy", "WSL_READONLY": "true", "WSL_ALLOWED_PATHS": "/var/log,/opt/app" }
        }
    }
}
```

`WSL_DISTRO` is the whole minimum (the name as `wsl -l -q` prints it). Because each server fronts one distro *as one user*, the agent never picks either: `wsl_exec({ command: "df -h" })` is a complete call, and root access is a matter of which entry exists — not of an argument. The server name is what the agent sees in its tool list, so put the user in it.

The server speaks MCP over **stdio**: stdout carries the JSON-RPC stream and all logging goes to stderr.

## 🗂️ Distro configuration

| `WSL_*` variable | Description |
|---|---|
| `WSL_DISTRO` ✅ | Distro name as `wsl -l -q` prints it. Required by name — following `wsl --set-default` would let a machine-wide setting silently redirect every command |
| `WSL_USER` | Linux user (`wsl -u`). The distro's default user when unset |
| `WSL_NAME` | Alias shown to the agent; defaults to the distro name |
| `WSL_DESCRIPTION` | Shown to the agent — say what the distro is for |
| `WSL_CWD` | Directory new sessions start in |

### Policy

| `WSL_*` variable | Default | Effect |
|---|---|---|
| `WSL_READONLY` | `false` | Rejects write commands, output redirection, package installs, uploads and writes |
| `WSL_ALLOW_SUDO` | `true` | When false, rejects `sudo` / `su` / `doas` / `pkexec` / `runuser` / `chroot` |
| `WSL_ALLOW_WINDOWS` | **`false`** | When false, rejects Windows interop executables (`powershell.exe`, `cmd.exe`, any `.exe`) and **writes** whose target is under `/mnt/<drive>/`. Reads and copies *out of* `/mnt` are always allowed |
| `WSL_ALLOW_COMMANDS` | *(none)* | When set, only these binaries may run (`pwd` is added automatically so sessions can open) |
| `WSL_DENY_PATTERNS` | *(none)* | Extra regex sources, compiled at startup and tested per command segment |
| `WSL_ALLOWED_PATHS` | *(none)* | When set, the file tools accept only absolute paths inside these prefixes |
| `WSL_EXEC_TIMEOUT_MS` | `60000` | Per-command wall clock; `wsl.exe` is killed when it elapses |
| `WSL_MAX_OUTPUT` | `100000` | stdout and stderr are each truncated past this |
| `WSL_MAX_READ_BYTES` | `200000` | `wsl_read_file` ceiling |

The stance is `@akms/mcp-ssh`'s: **permissive by default**, restriction opt-in, and a malformed value fails startup (`WSL_READONLY=ture` is an error, not "not read-only"). The one default that differs is `WSL_ALLOW_WINDOWS`, and the reason is in the security notes below.

### Check it before wiring it up

```bash
akms-mcp-wsl --check          # or: npx -y @akms/mcp-wsl --check
```

```
Checking ubuntu  →  root@ubuntu

  OK      uid=0(root) gid=0(root) groups=0(root)  (115ms)
          distro: Running  ·  WSL 2  ·  networking mirrored  ·  systemd  ·  kernel 5.15.146.1-microsoft-standard-WSL2
```

## 🧰 Tools

| Tool | Purpose |
|---|---|
| `wsl_list_hosts` | The configured distro and user, the guard policy, and the distro's state: running/stopped, WSL version, networking mode, whether systemd is PID 1 |
| `wsl_connect` | Open a session (a remembered working directory), returns a session id |
| `wsl_disconnect` | Forget a session |
| `wsl_list_sessions` | Open sessions with cwd, command count and idle time |
| `wsl_exec` | Run a command in a login bash; returns stdout, stderr, exit code, duration |
| `wsl_list_dir` | Directory listing (type, mode, size, mtime) |
| `wsl_read_file` | Read a text file, truncated to the byte ceiling |
| `wsl_write_file` | Write or append UTF-8 text |
| `wsl_upload` | Local → distro file transfer |
| `wsl_download` | Distro → local file transfer |

### Every call is its own process

There is no connection to keep. Each tool call spawns `wsl.exe -d <distro> -u <user> --exec bash -lc <script>` and waits for it — about 100 ms of overhead, no handshake. A **session** therefore carries exactly one thing between calls: the working directory, so `cd /opt/app` in one `wsl_exec` still applies to the next. Environment variables, background jobs and `sudo` timestamps do not carry over, because the process that held them has exited.

`--exec`, never `--`: with `--`, `wsl.exe` hands the command to the distro's default shell for a *second* parse, which strips backslashes and expands `$HOME` before bash ever sees the script — the text the guard screened would not be the text that runs.

### Commands run without a terminal

stdin is closed, so anything that waits for input fails fast instead of hanging until the timeout: `sudo` without `NOPASSWD` fails with `a password is required`, prompts need their non-interactive flag (`apt-get -y`), full-screen tools have no TTY (`top -bn1`, `wsl_write_file` instead of an editor).

**A background job must detach all three descriptors**, or `wsl.exe` waits on the open pipe until the timeout kills it:

```bash
nohup ./build.sh > /tmp/build.log 2>&1 < /dev/null &
```

When the timeout fires, `wsl.exe` is killed; the process inside the distro may survive. The reply says so.

### File tools go through the distro process

`wsl_read_file` is `head -c`, `wsl_write_file` is `cat >`, transfers are `cat` over stdin/stdout — byte-clean pipes, so binaries round-trip intact. This is deliberate: the `\\wsl$\` share opens every file as the distro's *default* user, so a `root` entry could not have written `/etc/nginx/…` through it. Through the process, the registered user's permissions are the permissions.

These scripts have no variable part but the quoted path, so they bypass the command guard the way SFTP does in `@akms/mcp-ssh`; the **path** guard (`WSL_ALLOWED_PATHS`, read-only, the `/mnt` rules) governs them instead. `WSL_ALLOW_COMMANDS` need not list `cat` or `find`.

## 🛡️ Guard policy

The command guard is `@akms/mcp-ssh`'s, unchanged — catastrophe rules always on (`rm -rf /`, `mkfs`, `dd of=/dev/sda`, `shutdown`, fork bombs…), the rest opt-in. Its threat model is a **mistaken agent, not an adversary**, and so is this server's. On top:

| Layer | Scope | Examples |
|---|---|---|
| **WSL catastrophe** | Always | `wsl --shutdown` / `--terminate` / `--unregister`, `wslconfig /t`, `poweroff`, `systemctl poweroff`, `init 0` |
| `WSL_ALLOW_WINDOWS=false` | Default | any segment whose binary is a Windows executable (`powershell.exe`, `cmd.exe`, `explorer.exe`, `*.exe`); any write-shaped segment whose **target** is under `/mnt/<drive>/` — a redirection, `cp`'s last operand, `tar -c`'s archive, `rm`/`sed -i`/`mv` operands |
| **Operator paths** | Always, even when Windows is open | `/mnt/c/Users/<you>/.ssh`, `.aws`, `.gnupg`, `*.pem`, `.claude.json`, `.mcp.json`, `claude_desktop_config.json` — the same list `@akms/mcp-ssh` protects on the local side, reached through the mount |

Both `wsl_exec` and the file tools enforce these; the rules live in the layer every command and path passes through, so a new tool cannot forget them. A rejection returns the rule that fired, the offending segment, and the note that nothing was run.

## ⚠️ Security notes

**In WSL, the "remote" is your own machine.** `@akms/mcp-ssh` can say "the remote account is the real boundary" because a compromised remote account stays remote. Here the distro shares the Windows filesystem under `/mnt` and can launch Windows programs through interop — and among the files it can reach that way is the MCP client configuration that defines this server's own `WSL_*` policy. An agent that writes `~/.claude.json` rewrites its guards for the next run. That is why `WSL_ALLOW_WINDOWS` is the one restriction on by default, and why the operator's credential and configuration paths stay refused even when it is turned on.

- Prefer a dedicated Linux user per entry over `root`, with `sudoers` scoped to what it needs — the guard is a seatbelt, the account is the containment.
- The catastrophe rules read the command as text. A shell can express the same operation in unlimited ways; the guard stops mistakes, not intent.
- Output from the distro is untrusted input: a file the agent reads can contain instructions.
- Local paths in `wsl_upload` / `wsl_download` are resolved on Windows, so a POSIX-looking `/tmp/x` becomes `<current drive>\tmp\x`. Every transfer reply prints the resolved path — check it.

## 📄 Logging

Everything goes to **stderr**. `WSL_MCP_LOG_LEVEL` picks the level — `silent` / `debug` / `info` / `warn` / `error`, default `info`. Guard rejections are logged at `warn` with the full command; full command text is otherwise only logged at `debug`.

## 🧑‍💻 Development

Building on this server, embedding it as a library, or changing the guards — see [README_DEV.md](README_DEV.md).

## 📜 License

MIT — see [LICENSE.md](LICENSE.md).
