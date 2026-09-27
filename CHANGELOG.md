# Changelog

All notable changes to `@akms/mcp-wsl`. Dates are `YYYY-MM-DD`.

## 0.0.2 — 2026-09-28

- `package.json` declares `repository`, `homepage` and `bugs` pointing at
  `github.com/alkemic-studio/npm.akms.mcp-wsl`.
- `README_DEV.md` links `@akms/mcp-ssh` to its repository under `alkemic-studio`.

## 0.0.1 — 2026-09-28

Initial implementation. Design record: `akms.docs/mcp-wsl-design.md`.

- One server entry fronts one distro **and one user** (`WSL_DISTRO` + `WSL_USER`), declared
  as plain `WSL_*` variables — the `SSH_*` surface of `@akms/mcp-ssh` with the connection
  and authentication variables removed, because there is no connection.
- Commands run through `wsl.exe -d <distro> -u <user> --exec bash -lc <script>`. `--exec`
  rather than `--`: the latter hands the arguments to the distro's default shell for a
  second parse, which strips backslashes and expands `$VAR` before the guard's view of the
  command ever runs.
- Sessions remember a working directory only; each call is its own process.
- File tools stream through the distro process (`find` / `head -c` / `tee` / `cat`), so
  the registered user's permissions decide access — `\\wsl$\` would have used the distro's
  default user regardless.
- Guard policy is `@akms/mcp-ssh`'s, plus WSL catastrophe rules (`wsl --shutdown`,
  `poweroff`) and `WSL_ALLOW_WINDOWS` (default `false`): interop `.exe` execution and
  writes under `/mnt/<drive>/` are refused, and the operator's credential and MCP
  configuration paths under `/mnt/` are refused regardless.
