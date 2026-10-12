# pi-codex-computer-use

Read `CONTRIBUTING.md` before writing an issue, a commit, a pull request, or a comment.

## Agent skills

- **Issue tracker**: GitHub Issues for `mcdp-adk/pi-codex-computer-use`, through the `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Triage labels**: the five defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- **Domain docs**: single context, with `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Runtime behavior

Before relying on how the Codex runtime or pi behaves, read `docs/runtime-behavior.md`; record what you establish there, with its evidence.

## Workspace

The tracked tree holds only what the repo shares. Anything else an agent creates lives in one of two homes and is removed once it has served its purpose:

- **Worktrees**: `.worktrees/<topic>/`, one per branch, set up with `npm ci`, removed once the branch is merged or abandoned.
- **Working files**: `.local/<task>/` or a folder under the OS temp directory, one folder per task, removed once its result has landed in a commit or on GitHub.

Ignore `.worktrees/` and `.local/` through `.git/info/exclude`, not `.gitignore`.

## Invariants

### Public content

- The repo ships no Codex files; the Codex runtime is located on the user's machine at run time.
- Captures and logs stay local, unnamed by path.
