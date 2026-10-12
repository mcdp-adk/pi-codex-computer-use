---
name: codex-computer-use
description: Operate Windows desktop apps from pi through the Codex computer-use runtime, following Codex's own guidance for the REPL and sky. Use when a task involves observing or driving a desktop app — load it before the first computer_use cell, and whenever a screenshot, coordinate, window id, or REPL state looks stale.
---

# Codex computer use

`computer_use` runs your JavaScript cells in the Codex runtime's REPL, where **sky** observes and operates Windows app windows. Codex wrote model-facing guidance for exactly this runtime; this skill routes you to it, read in place, and covers only where driving it from pi differs.

## Required reading

The `computer_use` tool description lists the paths located when the extension loaded. Read all three before your first cell:

- **`guidance.md`** (`computer_use_guidance_path`) — operating guidance and mandatory safety rules.
- **`confirmations.md`** (`computer_use_confirmations_path`) — Codex's confirmation policy. It applies unchanged: before any action that touches the user's system or data, follow how it wants that action confirmed.
- **`sky-window2-api.md`** (`computer_use_sky_api_path`) — the sky API reference; use it after the guidance to look up the signatures of the calls you write.

## Stay on the tools

Act only through `computer_use` / `computer_use_reset`: they carry the turn metadata, app approvals, and lifecycle the runtime expects. Leave starting, restarting, and resetting the REPL to them.

## Driving from pi instead of inside Codex

Everything else — confirmation policy, cell semantics, sky usage — follows the documents above. The differences:

- **These two tools are the REPL's whole surface.** The REPL's other tools are not reachable from pi (the host sends `turn_ended` itself), so drive the desktop only through cells.
- **sky is already initialised.** Before your first cell in a REPL, the host runs Codex's Initialize cell, so `globalThis.sky` is ready; skip the guidance's Initialize step.
- **Reset with `computer_use_reset`.** It closes the REPL and clears all bindings and `globalThis` values; the next cell runs in a fresh REPL with sky initialised again.
- **App approvals are granted for you.** The host automatically accepts the runtime's app-approval requests; no app-approval prompt reaches you.
- **Confirmations happen in this conversation.** The policy in `confirmations.md` still governs which actions need a check; when one does, ask the user here and wait for the answer — there is no Codex-native confirmation prompt.
- **Browser windows are out of reach.** The Browser Use plugin the guidance prefers is not part of this runtime, so drive visible desktop application windows only.
- **Convert coordinates only when pi downscaled the image.** If pi appends a note like `[Image: original 2560x1392, displayed at 2000x1088. Multiply coordinates by 1.28 to map to original image.]`, multiply coordinates read from that image by the note's factor before passing them to sky. Without that note, use the screenshot coordinates unchanged.
- **Top-level `const`/`let`:** declarations persist across cells and may be redeclared; the redeclaration rule in `guidance.md` does not apply.