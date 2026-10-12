# Contributing

How work moves from issue to PR here, for whoever writes an issue, a commit, a PR, or a comment. The skills write specs, tickets, and PR bodies; this file states only what this project adds to them.

## Issues

An issue follows the `to-spec` and `to-tickets` templates. This project adds:

- **Triage labels.** The five state labels live in `docs/agents/triage-labels.md`, which also maps the `bug` and `enhancement` category labels.

## Commits

Conventional Commits:

- **Title only.** No scope and no body. *checked: commitlint*
- **One intention per commit.** The title describes the whole change.

## Pull requests

- Changes reach `main` through a PR unless the owner asks for a direct commit.
- The template at `.github/pull_request_template.md` gives the body its shape: the closing line — `Closes #N` when the PR finishes the issue, `Refs #N` when it does not — then `Summary`, `Evidence`, and `Merge Danger`. How to write each section is the `pr` skill's to teach.
- The `conventions` workflow checks the PR: the title passes commitlint (a squash merge can land it on `main` as a commit message), the body carries every template heading, and — once the PR is ready — every issue it closes has all of its acceptance criteria ticked. Failures name what to fix.

## Acceptance criteria

- Only the owner rewords an acceptance criterion; an agent proposes the new wording in conversation.
- Every ticked acceptance criterion has evidence.
- An issue closes only with every criterion ticked.

## Evidence

- Evidence separates what was observed from its suspected cause, and marks a cause not reproduced as a hypothesis.
- Evidence cites commits reachable from the PR or `main`, and states its results on GitHub.
