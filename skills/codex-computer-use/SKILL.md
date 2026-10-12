---
name: codex-computer-use
description: Operate Windows desktop apps from pi through the Codex computer-use runtime, following Codex's own guidance for the REPL and sky. Use when a task involves observing or driving a desktop app — load it before the first computer_use cell, and whenever a screenshot, coordinate, window id, or REPL state looks stale.
---

# Codex computer use

`computer_use` runs your JavaScript cells in the Codex runtime's REPL, where **sky** observes and operates Windows app windows. Codex wrote model-facing guidance for exactly this runtime; this skill routes you to it, read in place, and covers only where driving it from pi differs.

## Required reading

The `computer_use` tool description gives the located paths — the extension discovers them from the Codex configuration, so they match the runtime you are driving. Read all three before your first cell:

- **`guidance.md`** (`computer_use_guidance_path`) — the REPL's operating rules: the observe–act–refresh loop, waits and retries, keysym names, and what the runtime refuses to do.
- **`confirmations.md`** (`computer_use_confirmations_path`) — Codex's confirmation policy. It applies unchanged: before any action that touches the user's system or data, follow how it wants that action confirmed.
- **`sky-window2-api.md`** (`computer_use_sky_api_path`) — the sky API reference; use it after the guidance to look up the signatures of the calls you write.

## Stay on the tools

Act only through `computer_use` / `computer_use_reset`: they carry the turn metadata, app approvals, and lifecycle the runtime expects. Leave starting, restarting, and resetting the REPL to them.

## Driving from pi instead of inside Codex

Everything else — confirmation policy, cell semantics, sky usage — follows the documents above. The differences:

- **These two tools are the REPL's whole surface.** The REPL's other tools are not reachable from pi (the host sends `turn_ended` itself), so drive the desktop only through cells.
- **sky is already initialised.** Before your first cell in a REPL, the host runs Codex's Initialize cell, so `globalThis.sky` is ready; skip the guidance's Initialize step.
- **Reset with `computer_use_reset`.** It closes the REPL; the next cell starts in a fresh, empty one with sky initialised again.
- **App approvals are granted for you.** When the runtime asks for an app approval, the host accepts it while your turn is in flight; no approval prompt reaches you.
- **Confirmations happen in this conversation.** The policy in `confirmations.md` still governs which actions need a check; when one does, ask the user here and wait for the answer — there is no Codex-native confirmation prompt.
- **Browser windows are out of reach.** The Browser Use plugin the guidance prefers is not part of this runtime, so drive visible desktop application windows only.
- **Convert coordinates only when pi downscaled the image.** pi resizes an image only when it exceeds the model's image limits (by default 2000 px on a side, or 4.5 MB of base64 data), and then appends a note like `[Image: original 2560x1392, displayed at 2000x1088. Multiply coordinates by 1.28 to map to original image.]` — multiply coordinates read off such an image by the note's factor before passing them to sky. With no such note the image keeps the screenshot's own size, so coordinates need no conversion.
- **Top-level `const`/`let` persist and may be redeclared.** Unlike what the guidance says, top-level `const`/`let` declarations from earlier cells persist across cells and may be redeclared; keep values you need across cells on `globalThis` either way — but a reset clears the whole REPL, so bindings and `globalThis` values alike are gone and the fresh REPL starts empty.