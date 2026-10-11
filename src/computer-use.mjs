// Host facade over the REPL: initializes sky once per REPL, then exposes
// list_apps and take_screenshot as cell runs returning MCP content blocks.
// Host-logic file: must never import anything from pi. Zero dependencies.
import { ReplHost, RESET_NOTICE } from './repl.mjs';
import { readCodexConfig } from './config.mjs';
import { resolveSkyModule } from './sky-path.mjs';
import { LIST_APPS_CELL, skyInitCell, newScreenshotCell } from './cells.mjs';
export class ComputerUse {
  constructor(opts) {
    this.host = new ReplHost(opts);
    this.skyUrl = null;
    this.skyReady = false;
    // Set when the REPL was reset or relaunched; the next cell result carries
    // a reset notice at the start, then the flag clears.
    this.resetNotice = false;
    // True once the host has launched a REPL in this session at least once.
    this.startedBefore = false;
  }

  get running() {
    return this.host.running;
  }

  // Run a model cell, honouring pi's abort signal: pi passes an AbortSignal
  // to tool execute(); we forward it so the MCP request cancels promptly.
  async runCell(code, opts = {}) {
    await this.noticeIfRelaunched();
    await this.ensureSky();
    const r = await this.host.runCell(code, opts);
    if (r?.isError) throw textOf(r);
    return { text: this.attachResetNotice(textOf(r)), content: r.content };
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

  // Detect a REPL that exited between calls (crash / killed / window closed)
  // and arrange for the next cell result to carry a reset notice. The host's
  // ensureStarted relaunches it; ensureSky re-initialises sky.
  async noticeIfRelaunched() {
    if (!this.host.running && this.startedBefore) {
      this.resetNotice = true;
    }
    this.startedBefore = true;
    return this.resetNotice;
  }

  async listApps(opts = {}) {
    const { text, content } = await this.runCell(LIST_APPS_CELL, opts);
    return { text, content, images: [] };
  }

  // Screenshot a desktop window and return { text, images } where images is
  // a list of { data, mimeType } blocks the runtime emitted. This build of
  // sky has no cursor-position API, so we capture the first listed window;
  // the model can pick a specific window later once activation tools land.
  async takeScreenshot(opts = {}) {
    await this.ensureSky();
    const pickCell = `
const __all = await globalThis.__sky.list_windows();
const __win = __all[0];
if (!__win) throw new Error('no window available for screenshot');
nodeRepl.write(JSON.stringify({ id: __win.id, title: __win.title }));
`;
    const pickRun = await this.host.runCell(pickCell, { timeoutMs: 30000, ...opts });
    if (pickRun?.isError) throw new Error(textOf(pickRun));
    const win = JSON.parse(textOf(pickRun));

    const shotRun = await this.host.runCell(newScreenshotCell(win.id), { timeoutMs: 60000, ...opts });
    if (shotRun?.isError) throw new Error(textOf(shotRun));
    const images = (shotRun.content ?? [])
      .filter((c) => c.type === 'image')
      .map((c) => ({ data: c.data, mimeType: c.mimeType }));
    const text = this.attachResetNotice(textOf(shotRun));
    return { text, images };
  }

  // Reset: drop all REPL globals by closing the REPL and starting fresh; the
  // next cell re-initialises sky (ensureSky) and its result carries a notice
  // that REPL state was reset.
  async reset() {
    await this.host.close();
    this.skyReady = false;
    this.resetNotice = true;
    this.startedBefore = true;
  }

  // Attach a reset notice to a result iff one is pending. The notice goes at
  // the start of the result text, as the acceptance requires.
  attachResetNotice(text) {
    if (!this.resetNotice) return text;
    this.resetNotice = false;
    return `${RESET_NOTICE}\n${text}`;
  }

  // Ticket #5: Escape stop. Mark `runId` stopped; further computer-use cells
  // for that run are blocked until the next run clears it (TurnMeta regenerates
  // the run id per agent run, so there is nothing to reset here).
  stopRun(runId) {
    this._stoppedRunId = runId ?? this._stoppedRunId;
    return { stopped: this._stoppedRunId };
  }

  // Throw before a cell runs if this run has been Escape-stopped. Tools call
  // this first so a stopped run surfaces the runtime's stop, not a fresh cell.
  _assertNotStopped(runId) {
    if (this._stoppedRunId && runId && this._stoppedRunId === runId) {
      throw new Error('Computer use is stopped for this agent run (Escape pressed). The next prompt may use computer use again.');
    }
  }

  async close() {
    await this.host.close();
    this.skyReady = false;
    this.resetNotice = false;
    this.startedBefore = false;
  }
}

function textOf(r) {
  return (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}