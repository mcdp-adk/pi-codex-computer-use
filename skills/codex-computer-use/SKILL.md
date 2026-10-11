---
name: codex-computer-use
description: How to use the computer_use tools that host the Codex computer-use runtime (REPL, sky) to see and drive Windows desktop apps. Use the first time a computer-use task starts, and whenever coordinates, window ids, or state look stale.
---

# Codex computer use

The `computer_use` tools hand your code to the **Codex runtime** — the REPL that ships with the Codex desktop app — so you can look at and drive real Windows desktop apps through **sky**, Codex's UI-automation library. Codex wrote its own guidance for this runtime; **read it before writing cells**, and treat the guidance-plus-confirmation-rules as your operating instructions while the computer is in use.

## Load the Codex documents first

The extension discovers these files from the Codex configuration and reports their locations via `computer_use_tool_paths`. Read the three of them before your first cell, and `confirmations` before any action that touches a user's system or data:

- `computer_use_guidance_path` → **`guidance.md`** — the REPL's contract: every cell is JavaScript run by node_repl; state lives on `globalThis`; a cell returns text to **you** via `nodeRepl.write(string)`; use sky for everything Windows.
- `computer_use_confirmations_path` → **`confirmations.md`** — Codex's confirmation policy. It applies unchanged. If a step has no clear ask-once or confirm-at-action rule, stop and confirm with the user before acting.
- `computer_use_sky_api_path` → **`sky-window2-api.md`** — the sky API reference; use it after the guidance.

## Differences from driving it inside Codex

You are driving this runtime **from pi**, via MCP, not from inside the Codex agent. Three differences matter:

| Inside Codex | From pi (this host) |
|---|---|
| Codex auto-grants app approvals per its own rules | this host auto-grants **all** app approvals (policy decided at install time) |
| Codex's confirmation policy applies | **same** — read `confirmations.md` and follow it |
| `import { sky } from '@oai/sky'` resolves | the bare specifier does not resolve — import via the file URL from `computer_use_sky_api_path`'s surroundings (the host does this for the init cell; in your own cells store what you need on `globalThis`) |
| Codex shows the model screenshots natively | pi may shrink a large screenshot before the model sees it |

## Screenshot coordinates

`take_screenshot` returns an image. If pi logs that it **resized the image** before showing it to you, the pixel coordinates you see are in the *reduced* picture, not the real screen. Scale any click / move / focus coordinate by `realWidth / shownWidth` (and same for height) before handing it to sky. Get `realWidth × realHeight` from the image's original metadata or from sky.

## Working rules

1. **One observation per cell.** sky's element indexes and coordinates are only valid for the exact observation that produced them. Never reuse an index or a coordinate across cells; run the action cell with a fresh observation first.
2. **State across cells.** A top-level `const` / `let` (or `class` / `function`) from an earlier cell is *redeclared* on the next run and will throw. Store everything you need later on `globalThis` (`globalThis.sky = …`, `globalThis.win = …`).
3. **Return text with `nodeRepl.write(string)`** and return images with the runtime's image-emission — that is how a cell's result reaches you.
4. Keep each cell small: observe → act → refresh in their own cells.
5. **`computer_use_reset` restarts the REPL** — everything you put on `globalThis` is gone; re-run the setup step afterward.
6. The confirmation document's deny-list is not optional: no PowerShell / batch nesting, no copying or sending files / text / images the user did not explicitly approve, no uploads, no deletions, no account/permission changes, no CAPTCHA solving, no financial transactions.
