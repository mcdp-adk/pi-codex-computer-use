# Depend on Codex's installed files, not the running Codex app

The host launches the REPL from the Codex runtime's files with Codex's own environment, minus the three variables that route the helper through the running Codex app (`SKY_CUA_NATIVE_PIPE`, `SKY_CUA_NATIVE_PIPE_DIRECTORY`, `CODEX_CLI_PATH`), plus `NODE_REPL_DISABLE_ANALYTICS=1`. The REPL then starts its own helper, so computer use works whether or not Codex is open, never shares a helper with Codex, follows one code path, and sends no analytics; the variables are set only on the launched process, never persisted.

## Consequences

- Browser windows fail the helper's URL policy; browsers are out of scope.
- Codex account and admin policies no longer apply to this package's computer use.
- This is the path Codex itself does not use on Windows, so an update can break it unnoticed; failures surface as the runtime's own errors.
- Keeping `CODEX_CLI_PATH` makes every call fail with "codex app-server exited before returning response 1"; the cause is not reproduced (hypothesis: the helper's app-server child exits early under this environment).
- With this environment no network connections were observed from the launched processes (polling only, not packet capture; error paths not exercised). A Codex app-server process once appeared in the process tree with no connections; its cause is not reproduced.
