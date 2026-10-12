# Coding standards

How code in this repo is written, for whoever writes or reviews it. Collaboration conventions — issues, commits, and pull requests — live in `CONTRIBUTING.md`; this file covers code only. A rule marked *checked* is enforced by a check, which has the final say; review the rest by judgement.

## Design

- **Decisions and terms.** Code follows the decisions in `docs/adr/` and the terms in `GLOSSARY.md`. A change that departs from one updates it in the same PR.
- **Host logic stays pi-agnostic.** Only `src/extension.mjs` imports the pi agent; the rest of `src/` could serve a different host. *checked: `npm test`*
- **Every part has a production caller.** Parameters, options, exports, globals, and return values exist because production uses them; nothing is added only so a test can reach inside. *checked for exports and files: `npm run lint`*
- **Fail fast with the real cause.** A runtime error reaches the model as a tool error carrying the runtime's own message; the host adds context, never a paraphrase.

## Comments

- **Lasting behavior and its reason.** A comment says what the code guarantees and why. Review rounds, fix numbers, and tickets as future work belong in the PR.

## Tests

A test exists to buy confidence that the package works when the user really uses it, at the lowest maintenance cost. The closer a test is to how the package is used, the more confidence it gives (Kent C. Dodds), and a good test is sensitive to changes in behavior and insensitive to changes in structure (Kent Beck, Test Desiderata). Decide test layers, test doubles, and coverage by this principle. Here it means:

- **One seam.** A test drives a pi SDK session that loads the package as pi does, with pi's faux provider scripting the model, against the real Codex runtime. Only the model is replaced; the REPL is never faked, because the risk lives in the real runtime.
- **Observable results.** Assert what the user or the model sees: tool results, tool descriptions, which tools exist, notices, leftover processes.
- **A test proves its claim.** It fails when the behavior it names is removed. It waits on the observable event its claim depends on, such as a marker the cell writes once it runs, rather than on a fixed delay or an earlier event.
- **Visible skips.** When the machine cannot run a test, the test skips with a reason (`t.skip`, `describe.skip`).
- **Clean teardown.** Every session ends with `session_shutdown`, so no REPL process outlives its test; temporary files go through the harness.

## Model-facing text

- **Supported facts only.** The skill and the tool descriptions state only what the code or `docs/runtime-behavior.md` supports, and the skill lists only differences from the Codex guidance (ADR 0004).
- **New runtime facts are recorded.** A change that relies on Codex runtime or pi behavior not yet in `docs/runtime-behavior.md` adds it there, with its evidence.
