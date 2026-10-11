# Guide the model with a skill that points at Codex's own guidance

The package ships a `codex-computer-use` skill next to its extension, as Codex's computer-use plugin pairs the REPL with a skill. The tool descriptions stay short and always present; the skill loads only when a task involves desktop apps and sends the model to the Codex guidance in the Codex installation, read in place, listing only where this package differs. Covering Codex's guidance in full takes about 5–6k tokens, too much for every session's context, and reading it in place keeps it current with Codex and keeps its proprietary text out of this repository.

## Considered Options

- All guidance in the tool description: always in context, even in sessions that never use computer use.
- An adapted copy of the Codex guidance in the skill: republishes proprietary text and must be re-synced by hand after every Codex update.
- Pointers and differences in the tool description, without a skill: puts routing text in every request and departs from Codex's plugin layout.
- Namespace instructions or prompt injection: namespace instructions reach only codemode scripts, which cannot call a model-only tool, and prompt injection needs a trigger the package would have to invent.
