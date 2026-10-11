// Host facade over the REPL: initializes sky once per REPL, then runs cells
// against the desktop, returning MCP content blocks. Host-logic file: must
// never import anything from pi. Zero dependencies.
import { ReplHost, RESET_NOTICE } from './repl.mjs';
import { readCodexConfig } from './config.mjs';
import { resolveSkyModule } from './sky-path.mjs';
import { skyInitCell, LIST_APPS_CELL, newScreenshotCell } from './cells.mjs';

export class ComputerUse {
  constructor(opts) {
    this.host = opts?.host ?? new ReplHost(opts);
    this.skyUrl = null;
    this.skyReady = false;
    // Set when the REPL was reset or relaunched; the next cell result opens
    // with a reset notice, then the flag clears.
    this.resetNotice = false;
    // True once the host has launched a REPL in this session at least once.
    this.startedBefore = false;
    // Run id stopped by an abort (physical Escape): further cells in that run
    // are blocked until the next run begins (TurnMeta regenerates the run id).
    this._stoppedRunId = null;
  }

  get running() {
    return this.host.running;
  }

  // Run one model cell. `turnMeta` is the run's Codex-style metadata the cell
  // carries; `signal` is pi's AbortSignal, forwarded so the MCP request
  // cancels promptly on abort.
  async runCell(code, { signal, timeoutMs, turnMeta } = {}) {
    await this.noticeIfRelaunched();
    await this.ensureSky();
    const r = await this.host.runCell(code, { signal, timeoutMs, turnMeta });
    if (r?.isError) throw new Error(textOf(r) || 'REPL cell failed');
    // A pending reset notice rides along as the FIRST text block: the
    // extension passes content through verbatim, so putting it only in
    // `text` would drop it from the model's tool result.
    if (this.resetNotice) {
      this.resetNotice = false;
      return {
        text: `${RESET_NOTICE}\n${textOf(r)}`,
        content: [{ type: 'text', text: RESET_NOTICE }, ...(r.content ?? [])],
      };
    }
    return { text: textOf(r), content: r.content ?? [] };
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
      this.skyReady = false;
    }
    this.startedBefore = true;
    return this.resetNotice;
  }

  async listApps(opts = {}) {
    return this.runCell(LIST_APPS_CELL, opts);
  }

  // Screenshot a desktop window: returns { text, images } where images are the
  // runtime's image blocks ({ data, mimeType }). Skips minimized windows —
  // the runtime cannot capture those.
  async takeScreenshot(opts = {}) {
    await this.noticeIfRelaunched();
    await this.ensureSky();
    const pickCell = `
const __all = await globalThis.__sky.list_windows();
const __win = __all.find((w) => !w.isMinimized) ?? __all[0];
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
    const text = textOf(shotRun);
    return { text, images, content: shotRun.content ?? [] };
  }

  // Reset: close the REPL and start fresh; the next cell re-initialises sky
  // (ensureSky) and its result carries a notice that REPL state was reset.
  async reset() {
    await this.host.close();
    this.skyReady = false;
    this.resetNotice = true;
    this.startedBefore = true;
    return { text: 'Codex REPL reset.' };
  }

  // Tell the runtime the turn has ended (normal or aborted). Codex's own
  // hooks do the same on Stop/Interrupt, and the runtime uses it so a
  // physical Escape stops computer use for the rest of the agent run. On an
  // abort (Escape) the run id is marked stopped first so further cells in the
  // same run refuse to run, then the runtime is notified.
  /**
   * @param {{ session_id: string, run_id: string }} turnMeta
   * @param {{ aborted?: boolean }} [opts]
   */
  async endRun(turnMeta, { aborted = false } = {}) {
    if (aborted) this.stopRun(turnMeta?.run_id);
    if (!this.host.running) return; // no REPL — nothing to signal
    await this.host.turnEnded(turnMeta, { hookEventName: aborted ? 'Interrupt' : 'Stop' });
  }

  // Mark `runId` stopped: further computer-use cells in that run throw. The
  // host owns the stop id because the cell-level surface is the host's (the
  // MCP layer); the next run's fresh id simply no longer matches.
  stopRun(runId) {
    this.host.stopRun?.(runId ?? null);
    return { stopped: runId ?? null };
  }

  // Throw before a cell runs if this run has been stopped (Escape aborted it).
  // Delegated to the host so a stubbed MCP layer enforces it too.
  _assertNotStopped(runId) {
    this.host._assertNotStopped?.(runId);
  }

  // Attach a reset notice to a plain-text result (no content blocks to ride
  // along with). The notice goes at the start of the text.
  attachResetNotice(text) {
    if (!this.resetNotice) return text;
    this.resetNotice = false;
    return `${RESET_NOTICE}\n${text}`;
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
