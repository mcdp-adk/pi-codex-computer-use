---
name: codex-computer-use
description: How to use the computer_use tools that host the Codex computer-use runtime (REPL, sky) to see and drive Windows desktop apps. Use the first time a computer-use task starts, and whenever coordinates, window ids, or state look stale.
---

# Codex computer use

The `computer_use` tools hand your code to the **Codex runtime** — the REPL that ships with the Codex desktop app — so you can look at and drive real Windows desktop apps through **sky**, Codex's UI-automation library. Codex wrote its own guidance for this runtime; **read it before writing cells**, and treat the guidance-plus-confirmation-rules as your operating instructions while the computer is in use.

## Load the Codex documents first

The extension discovers these files from the Codex configuration and reports their locations in the `computer_use` tool description. Read all three before your first cell:

- `computer_use_guidance_path` → **`guidance.md`** — the REPL's operating rules.
- `computer_use_confirmations_path` → **`confirmations.md`** — Codex's confirmation policy. It applies unchanged; read it before any action that touches a user's system or data, and if a step has no clear ask-once or confirm-at-action rule, stop and confirm with the user first.
- `computer_use_sky_api_path` → **`sky-window2-api.md`** — the sky API reference; use it after the guidance.

## Never bypass the helper tools

Always act through `computer_use` / `computer_use_reset`. Do not start the REPL yourself, do not run its binary directly, and do not reach around the tools to talk to the runtime — the tools carry the turn metadata, approvals, and lifecycle the runtime expects.

## Differences from driving it inside Codex

You are driving this runtime **from pi**, via MCP, not from inside the Codex agent. The differences that matter:

- **App approvals are auto-granted at run time.** When the REPL asks for an app approval, this host accepts it when the turn is in flight — there is no install-time policy; inside Codex the app asks you.
- **These tools instead of the REPL's own.** Drive the desktop only through `computer_use` / `computer_use_reset`; the REPL's other tools are not reachable from here (the host sends `turn_ended` itself).
- **sky is already initialised by the host.** Inside your cells `globalThis.sky` is already available (the host runs Codex's own Initialize cell when the REPL starts), and `@oai/sky` resolves as a bare dynamic import: `const { sky } = await import("@oai/sky")`. Top-level static imports are rejected — use `await import(...)` for every module you load in a cell.
- **Use `computer_use_reset` for resets.** Don't drop and restart the REPL yourself; the reset tool closes it, and the next `computer_use` call starts a fresh REPL with the host's sky init already run before your cell — the fresh REPL starts empty otherwise.
- **No browser automation.** The Codex guidance says "Prefer Browser Use plugin for browser automation"; that plugin is not part of this runtime, so browser windows cannot be driven — drive visible desktop application windows only.
- **Confirmations are asked in the conversation.** Codex's confirmation policy still governs which actions need a check; when one does, ask the user here in the conversation instead of relying on a Codex-native confirmation prompt.
- **Convert coordinates when a screenshot was downscaled.** Screenshots may be resized by the host; when that happens pi appends a note after the image of the form `[Image: original 1920x1080, displayed at 1280x720. Multiply coordinates by 0.67 to map to original image.]` — scale coordinates by the multiplier in the note before using them with sky.
- **Top-level `const`/`let` persist and may be redeclared.** Unlike what the Codex guidance says, top-level `const`/`let` declarations from earlier cells persist across cells and may be redeclared; keep values you need across cells on `globalThis` either way — only `globalThis` survives a reset.

Everything else — confirmation policy, cell semantics, sky usage — follows the Codex documents above.