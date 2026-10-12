# pi-codex-computer-use

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

### Acceptance criteria

- Only the owner rewords an acceptance criterion; an agent proposes the new wording in conversation.
- Every ticked acceptance criterion has evidence.
- An issue closes only with every criterion ticked.

### Evidence

- Evidence separates what was observed from its suspected cause, and marks a cause not reproduced as a hypothesis.
- Evidence cites commits reachable from the PR or `main`, and states its results on GitHub.

### Pull requests

- Changes reach `main` through a PR unless the owner asks for a direct commit.
- A PR for an issue starts with `Closes #N` when it finishes the issue, or `Refs #N` when it doesn't.
