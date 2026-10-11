// Host facade over the REPL: initializes sky once per REPL, then exposes
// list_apps and take_screenshot as cell runs returning MCP content blocks.
// Host-logic file: must never import anything from pi. Zero dependencies.
import { ReplHost } from './repl.mjs';
import { readCodexConfig } from './config.mjs';
import { resolveSkyModule } from './sky-path.mjs';
import { LIST_APPS_CELL, skyInitCell, newScreenshotCell } from './cells.mjs';
export class ComputerUse {
  constructor(opts) {
    this.host = new ReplHost(opts);
    this.skyUrl = null;
    this.skyReady = false;
  }

  get running() {
    return this.host.running;
  }

  async ensureSky() {
    if (this.skyReady) return;
    const cfg = readCodexConfig();
    if (cfg.missing) throw new Error(`Cannot start Codex REPL: missing ${cfg.missing.join('; ')}`);
    this.skyUrl = resolveSkyModule(cfg.env);
    const r = await this.host.runCell(skyInitCell(this.skyUrl), { timeoutMs: 30000 });
    if (r?.isError) throw new Error(`sky init failed: ${textOf(r)}`);
    this.skyReady = true;
  }

  async listApps() {
    await this.ensureSky();
    const r = await this.host.runCell(LIST_APPS_CELL);
    if (r?.isError) throw new Error(textOf(r));
    return textOf(r);
  }

  // Screenshot a desktop window and return { text, images } where images is
  // a list of { data, mimeType } blocks the runtime emitted. This build of
  // sky has no cursor-position API, so we capture the first listed window;
  // the model can pick a specific window later once activation tools land.
  async takeScreenshot() {
    await this.ensureSky();
    const pickCell = `
const __all = await globalThis.__sky.list_windows();
const __win = __all[0];
if (!__win) throw new Error('no window available for screenshot');
nodeRepl.write(JSON.stringify({ id: __win.id, title: __win.title }));
`;
    const pickRun = await this.host.runCell(pickCell, { timeoutMs: 30000 });
    if (pickRun?.isError) throw new Error(textOf(pickRun));
    const win = JSON.parse(textOf(pickRun));

    const shotRun = await this.host.runCell(newScreenshotCell(win.id), { timeoutMs: 60000 });
    if (shotRun?.isError) throw new Error(textOf(shotRun));
    const images = (shotRun.content ?? [])
      .filter((c) => c.type === 'image')
      .map((c) => ({ data: c.data, mimeType: c.mimeType }));
    return { text: textOf(shotRun), images };
  }

  async close() {
    await this.host.close();
    this.skyReady = false;
  }
}

function textOf(r) {
  return (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}