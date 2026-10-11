// Each cell is a plain string of JavaScript run in the REPL's `js` tool. Host-logic file: no pi imports, zero dependencies.
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