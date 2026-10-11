// Tool cells for the Codex REPL. Each is a plain string of JavaScript run in
// the REPL's `js` tool. Host-logic file: no pi imports, zero dependencies.
// Cells are module bodies: no top-level `return`. Output goes through
// nodeRepl.write; the helper emits screenshots as image content items.

// Sky init, the same cell Codex's own Initialize runs: a bare dynamic import
// (the runtime resolves `@oai/sky` from its own module directories; only
// top-level static imports are rejected). Idempotent — the reset path and a
// relaunch after a crash must both be able to run it.
export const SKY_INIT_CELL = `
if (!globalThis.sky) {
  const { sky } = await import("@oai/sky");
  globalThis.sky = sky;
}
`;

const LIST_APPS_CELL = `
const __apps = await globalThis.sky.list_apps();
const __withWindows = __apps.filter((a) => a.windows?.length);
nodeRepl.write(JSON.stringify(__withWindows.map((a) => ({
  id: a.id,
  displayName: a.displayName,
  windows: a.windows.map((w) => ({ id: w.id, title: w.title })),
}))));
`;

// Pick a capture target the runtime will allow. The real sky Window type
// (@oai/sky, window2) has no minimized flag; instead the cell activates the
// first window, which input calls require and whose own error advice —
// call activate_window, refresh with get_window, retry — this follows.
const PICK_WINDOW_CELL = `
const __all = await globalThis.sky.list_windows();
if (!__all.length) throw new Error('no window available for screenshot');
await globalThis.sky.activate_window({ window: __all[0] });
const __win = await globalThis.sky.get_window({ id: __all[0].id, app: __all[0].app });
nodeRepl.write(JSON.stringify({ id: __win.id, app: __win.app, title: __win.title }));
`;

export const SCREENSHOT_CELL_TPL = `
const __all = await globalThis.sky.list_windows();
const __win = __all.find((w) => w.id === __WINDOW_ID__)
  ?? __all[0];
if (!__win) throw new Error('no window available for screenshot');
const __state = await globalThis.sky.get_window_state({
  window: __win,
  include_screenshot: true,
  include_text: false,
});
const __shots = __state.screenshots ?? [];
nodeRepl.write(JSON.stringify({ window: { id: __win.id, title: __win.title }, screenshots: __shots.length }));
`;

export function newScreenshotCell(windowId) {
  return SCREENSHOT_CELL_TPL.replace('__WINDOW_ID__', JSON.stringify(windowId));
}

export function pickWindowCell() {
  return PICK_WINDOW_CELL;
}