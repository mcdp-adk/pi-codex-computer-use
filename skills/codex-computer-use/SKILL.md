---
name: codex-computer-use
description: How to use the computer_use tools that host the Codex computer-use runtime (REPL, sky) to see and drive Windows desktop apps. Use the first time a computer-use task starts, and whenever coordinates, window ids, or state look stale.
---

# Codex computer use

The `computer_use` tools hand your code to the **Codex runtime** — the REPL that ships with the Codex desktop app — so you can look at and drive real Windows desktop apps through **sky**, Codex's UI-automation library. Codex wrote its own guidance for this runtime; **read it before writing cells**, and treat the guidance-plus-confirmation-rules as your operating instructions while the computer is in use.

## Load the Codex documents first

The extension discovers these files from the Codex configuration and reports their locations in the `computer_use` tool description. Read all three before your first cell:

- `computer_use_guidance_path` → **`guidance.md`** — the REPL's operating rules. Follow them exactly: one observation per cell, no reusing indexes or coordinates across cells, and state on `globalThis`.
- `computer_use_confirmations_path` → **`confirmations.md`** — Codex's confirmation policy. It applies unchanged; read it before any action that touches a user's system or data, and if a step has no clear ask-once or confirm-at-action rule, stop and confirm with the user first.
- `computer_use_sky_api_path` → **`sky-window2-api.md`** — the sky API reference; use it after the guidance.

## Never bypass the helper tools

Always act through `computer_use` / `computer_use_reset`. Do not start the REPL yourself, do not run its binary directly, and do not reach around the tools to talk to the runtime — the tools carry the turn metadata, approvals, and lifecycle the runtime expects.

## Differences from driving it inside Codex

You are driving this runtime **from pi**, via MCP, not from inside the Codex agent. The differences that matter:

- **App approvals are auto-granted.** This host accepts every app-approval request (policy decided at install time); inside Codex the app asks you.
- **sky resolves via a file URL.** The bare `import { sky } from '@oai/sky'` does not resolve from pi-driven cells; the host's init cell imports sky by file URL once, so inside your cells `globalThis.sky` is already available. If you need other modules, import them by file URL.
- **State persists on the host between cells.** Cells run in one REPL across the session; `computer_use_reset` closes it and the next cell starts in a fresh one where only the host's sky init has run.
- **Screenshots may be resized by the host.** `take_screenshot` returns an image; if it was shrunk, scale coordinates by `realWidth / shownWidth` before using them with sky.

Everything else — confirmation policy, cell semantics, sky usage — follows the Codex documents above.