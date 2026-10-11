# pi-codex-computer-use

Lets the pi coding agent drive Windows desktop apps by hosting the computer-use runtime that ships with the Codex desktop app.

## Language

### Runtime

**Codex installation**:
The Codex desktop app's files on the user's machine, found through Codex's configuration; it provides the Codex runtime and the Codex guidance.
_Avoid_: Codex app (the running program)

**Codex runtime**:
The computer-use runtime installed with the Codex desktop app on the user's machine: the REPL, sky, and the helper.
_Avoid_: Codex bundle, cua_node

**REPL**:
The long-lived JavaScript REPL from the Codex runtime in which the model's code runs, keeping its state between cells.
_Avoid_: kernel, node_repl

**Cell**:
One piece of JavaScript the model submits to the REPL in a single tool call.
_Avoid_: snippet, script

**sky**:
The Codex runtime's JavaScript API for observing and operating Windows app windows.
_Avoid_: CUA API

**Helper**:
The native process from the Codex runtime that captures windows and sends input to the desktop.
_Avoid_: driver

**Codex guidance**:
Codex's own model-facing documents for computer use, read in place from the Codex installation.
_Avoid_: Codex docs, Codex skill

### Hosting

**Host**:
The process that launches the REPL, answers its app approvals, and owns its lifetime: the Codex app inside Codex, this package inside pi.
_Avoid_: bridge, adapter, wrapper

**App approval**:
The runtime's request for consent before it acts on an app; this package always grants it.
_Avoid_: permission prompt, confirmation

**Confirmation**:
The model asking the user in the conversation, and waiting for an answer, before a risky action such as deleting data or sending a message.
_Avoid_: approval

**Agent run**:
One user prompt handled by pi, from the prompt to the agent's final answer; the runtime treats it as one turn.
_Avoid_: turn (pi uses "turn" for one model request)

**Escape stop**:
Pressing the physical Escape key during computer use, which stops all further computer use for the rest of the agent run.
_Avoid_: interrupt, abort (pi's abort cancels a tool call, not computer use)
