# Coding standards

How code in this repo is written, for whoever writes or reviews it. Collaboration conventions — issues, commits, and pull requests — live in `CONTRIBUTING.md`; this file covers code only. A rule marked *checked* is enforced by a check, which has the final say; review the rest by judgement.

## Design

- **Decisions and terms.** Code follows the decisions in `docs/adr/` and the terms in `GLOSSARY.md`. A change that departs from one updates it in the same PR.
- **Host logic stays pi-agnostic.** Only `src/extension.ts` imports the pi agent; the rest of `src/` could serve a different host. *checked: `npm test`*
- **Every part has a production caller.** Parameters, options, exports, globals, and return values exist because production uses them; nothing is added only so a test can reach inside. *checked for exports and files: `npm run lint`*
- **TypeScript without a build.** All code is TypeScript — `src/`, `test/`, and `scripts/` — checked by the compiler in `npm run lint`; only configuration files stay JavaScript (`commitlint.config.mjs`). Node and pi load the `.ts` source directly, so nothing is compiled or emitted. *checked: `npm run lint`*
- **Erasable syntax only.** No enums, namespaces, or parameter properties — only syntax Node and pi's loader can strip unchanged. *checked: `npm run lint`*
- **Relative imports name the file that exists.** Node and pi run the source as written, so an import names the `.ts` file: `./computer-use.ts`. *checked for extensionless paths: `npm run lint`*
- **Types describe the real shape.** Parsed JSON and TOML and caught errors start as `unknown` and are narrowed before use; an `any` turns checking off, so it carries a comment saying why.
- **Fail fast with the real cause.** An error helps only if it names what actually went wrong. A runtime error reaches the model carrying the runtime's own message, with the host's context added, never a paraphrase; a malformed file or value is reported as malformed, never as a different cause.

## Comments

- **Lasting behavior and its reason.** A comment says what the code guarantees and why. Review rounds, fix numbers, and tickets as future work belong in the PR.

## Tests

A test exists to buy confidence that the package works when the user really uses it, at the lowest maintenance cost. The closer a test is to how the package is used, the more confidence it gives (Kent C. Dodds), and a good test is sensitive to changes in behavior and insensitive to changes in structure (Kent Beck, Test Desiderata). Decide test layers, test doubles, and coverage by this principle. Here it means:

- **One seam.** A test drives a pi SDK session that loads the package as pi does, with pi's faux provider scripting the model, against the real Codex runtime. Only the model is replaced; the REPL is never faked, because the risk lives in the real runtime.
- **Observable results.** Assert what the user or the model sees: tool results, tool descriptions, which tools exist, notices, leftover processes.
- **A test proves its claim.** It fails when the behavior it names is removed. It waits on the observable event its claim depends on, such as a marker the cell writes once it runs, rather than on a fixed delay or an earlier event.
- **Own windows.** A test captures or sends input only to windows it opens itself, and closes them in teardown, also when it fails.
- **Visible skips.** When the machine cannot run a test, the test skips with a reason (`t.skip`, `describe.skip`).
- **Clean teardown.** Every session ends with `session_shutdown`, so no REPL process outlives its test; temporary files go through the harness.

## Model-facing text

- **Supported facts only.** The skill and the tool descriptions state only what the code or `docs/runtime-behavior.md` supports, and the skill lists only differences from the Codex guidance (ADR 0004).
- **New runtime facts are recorded.** A change whose code relies on Codex runtime or pi behavior not yet in `docs/runtime-behavior.md` adds it there, with its evidence.
