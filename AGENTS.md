# pi-codex-computer-use

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `mcdp-adk/pi-codex-computer-use`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

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
