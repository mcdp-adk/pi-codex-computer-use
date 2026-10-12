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
