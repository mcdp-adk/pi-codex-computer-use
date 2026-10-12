# Runtime behavior

How the Codex runtime and pi actually behave, as far as this package depends on them. Codex documents none of this for a host other than Codex, so each fact was established by observation, and each names how:

- **test**: re-checked by `npm test` (the named test fails if the fact stops holding).
- **source**: read in the runtime's shipped JavaScript or binary strings.
- **probe**: a one-off cell or script; not re-checked.
- **manual**: an owner-driven pi session; the linked issue holds the evidence.

Verified against the Codex runtime `cua_node/cfb32733c877621e` and the bundled `computer-use` plugin `26.1007.21434`. When Codex updates, re-check the facts that are not under test before relying on them, and update this file when one changes.

## REPL tools

- The REPL serves `js` (`code`, `title`, `timeout_ms`), `js_reset`, `js_add_node_module_dir`, and `turn_ended` (`hook_event_name`, `session_id`, `turn_id`). *source*
- `js` runs a cell for 30000 ms when `timeout_ms` is omitted. *source*
- A failed cell returns `isError` with the error's `message` only; its `cause` is dropped. *probe*
- App approvals arrive as form elicitations; accepting with empty content grants them. *test: computer-use, criterion 2*

## Turn metadata and turn end

- Per-cell turn metadata travels as `params._meta["x-codex-turn-metadata"]` on `tools/call`, and the cell sees it as `nodeRepl.requestMeta`. Nothing else reaches it: the stdio `tools/call` has no other metadata field. *test: turn-meta*
- `turn_ended` runs the handlers trusted libraries registered with `addTurnEndedHandler`. Only the browser service registers one; sky does not, so for computer use the call has no effect. Codex itself ends the helper's turn through its `notify` hook (`codex-computer-use.exe turn-ended`), a path pi does not have. *source*

## Cells

- `await import("@oai/sky")` resolves; a top-level static import is rejected with a message naming the dynamic form. *test: every runtime test (sky init)*
- `process` is unavailable; `await import("node:fs")` works. *probe*
- Top-level `const`/`let` persist across cells and can be redeclared (a redeclared `const` prints a warning). Codex's guidance says otherwise. *probe*
- An uncaught error in a cell does not end the session: later cells keep running against the same REPL, with sky still initialised. *test: reset-notice*
- `nodeRepl.env` shows only the variables in `NODE_REPL_UNTRUSTED_ENV_ALLOWLIST`, so a cell cannot read its launch environment. `nodeRepl.tmpDir` follows `TMP`/`TEMP`. *test: computer-use, criterion 6*

## Launch environment

- The REPL needs `NODE_REPL_TRUSTED_CODE_PATHS` from Codex's configuration to trust `@oai/sky/service`; without it, sky fails with "Trusted RPC package must resolve within a configured trusted module directory". *probe*
- The three app-routing variables reach sky if the host passes them on: pointed at a missing pipe, they make sky calls fail. ADR 0002 names the variables and the `CODEX_CLI_PATH` failure. *probe; the host stripping them is under test: computer-use, criterion 6*

## Abort and Escape

- Cancelling a `tools/call` returns at once, but the cell keeps running to completion; a cell sent next starts only after it ends. *test: reset-abort, criterion 3 (prompt return); manual, [#6](https://github.com/mcdp-adk/pi-codex-computer-use/issues/6) and [#5](https://github.com/mcdp-adk/pi-codex-computer-use/issues/5) (the cell keeps running)*
- A physical Escape makes the helper write a marker under `<CODEX_HOME>/cache/computer-use/interrupts/<session>/<turn>`. Every later sky request with that session and turn id is rejected with "Computer Use was stopped by the user with the physical Escape key. …"; a new turn id works again. Input already sent is not undone. *source; manual, [#5](https://github.com/mcdp-adk/pi-codex-computer-use/issues/5)*

## sky and the helper

- Browser windows fail `get_window_state` with "could not determine the current browser URL on Windows with enough confidence to enforce policy". *probe*
- A minimized window fails `get_window_state` with "window is minimized; call activate_window, refresh with get_window, then retry get_window_state". *probe*
- `click`/`scroll` take window-relative `x`/`y` in the pixel space of the screenshot `get_window_state` returned, also at 150% display scaling. *manual, [#4](https://github.com/mcdp-adk/pi-codex-computer-use/issues/4)*
- Some apps expose no accessibility tree (Unigram returned an empty tree), leaving coordinates as the only way to act. *manual*

## pi

- pi downscales an image only when it exceeds the model's `inputLimits.images.resize` (by default 2000 px on a side or 4.5 MB of base64), and then appends `[Image: original WxH, displayed at wxh. Multiply coordinates by R to map to original image.]`. *source; manual, [#4](https://github.com/mcdp-adk/pi-codex-computer-use/issues/4)*
- pi awaits `agent_settled` listeners before a run settles, so slow work there delays the prompt's return after an abort. *source*
- A pi SDK session with file-backed defaults writes `auth.json` and `models-store.json` into its agent directory; tests pass an in-memory model runtime instead. *probe*
