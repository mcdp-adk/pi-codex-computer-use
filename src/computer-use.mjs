// Host facade over the REPL: initializes sky once per REPL, then runs cells
// against the desktop, returning MCP content blocks. Host-logic file: must
// never import anything from pi. Zero dependencies.
import { ReplHost, RESET_NOTICE } from './repl.mjs';
import { readCodexConfig } from './config.mjs';
import { checkSkyModule } from './sky-path.mjs';
import { SKY_INIT_CELL, pickWindowCell, newScreenshotCell } from './cells.mjs';

export class ComputerUse {
  constructor(opts) {
    this.host = opts?.host ?? new ReplHost(opts);
    this.skyReady = false;
    // Set when the REPL was reset or relaunched; the next cell result opens
    // with a reset notice, then the flag clears.
    this.resetNotice = false;
    // True once the host has launched a REPL in this session at least once.
    this.startedBefore = false;
  }

  get running() {
    return this.host.running;
  }

  // Run one model cell. `turnMeta` is the run's Codex-style metadata the cell
  // carries; `signal` is pi's AbortSignal, forwarded so the MCP request
  // cancels promptly on abort. A pending reset notice rides along as the
  // FIRST content block even when the cell fails.
  async runCell(code, { signal, timeoutMs, turnMeta } = {}) {
    await this.noticeIfRelaunched();
    try {
      await this.ensureSky({ signal, turnMeta });
      const r = await this.host.runCell(code, { signal, timeoutMs, turnMeta });
      if (r?.isError) throw new Error(textOf(r) || 'REPL cell failed');
      return withResetNotice(this, { text: textOf(r), content: r.content ?? [] });
    } catch (err) {
      // The notice still rides along when the cell errors: the model
      // sees that the state came from a fresh REPL, not the one it knew.
      if (this.resetNotice) {
        const message = err instanceof Error ? err.message : String(err);
        err = new Error(`${RESET_NOTICE}\n${message}`);
      }
      throw err;
    }
  }

  async ensureSky({ signal, turnMeta } = {}) {
    if (this.skyReady) return;
    const cfg = readCodexConfig();
    if (cfg.missing) throw new Error(`Cannot start Codex REPL: missing ${cfg.missing.join('; ')}`);
    checkSkyModule(cfg.env);
    const r = await this.host.runCell(SKY_INIT_CELL, { timeoutMs: 30000, signal, turnMeta });
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

  // Enumerate desktop windows through the real runtime (the discovery
  // acceptance lists apps successfully through a migrated CODEX_HOME).
  async listApps(opts = {}) {
    return this.runCell(
      `nodeRepl.write(JSON.stringify(await globalThis.sky.list_apps()));`,
      opts,
    );
  }

  // Screenshot a desktop window: returns { text, images } where images are the
  // runtime's image blocks ({ data, mimeType }). The pick cell uses only real
  // sky Window fields (id, app, title) plus activate_window, whose error
  // advice is the runtime's own way of handling windows it cannot capture.
  async takeScreenshot(opts = {}) {
    await this.noticeIfRelaunched();
    await this.ensureSky(opts);
    const pickRun = await this.host.runCell(pickWindowCell(), { timeoutMs: 30000, ...opts });
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
  // physical Escape stops computer use for the rest of the agent run.
  /**
   * @param {{ session_id: string, turn_id: string }} turnMeta
   * @param {{ aborted?: boolean }} [opts]
   */
  async endRun(turnMeta, { aborted = false } = {}) {
    if (!this.host.running) return; // no REPL — nothing to signal
    await this.host.turnEnded(turnMeta, { hookEventName: aborted ? 'Interrupt' : 'Stop' });
  }

  async close() {
    await this.host.close();
    this.skyReady = false;
    this.resetNotice = false;
    this.startedBefore = false;
  }
}

// Serve a pending reset notice on a successful cell result: it rides along as
// the FIRST content block (the extension passes content through verbatim, so
// putting it only in `text` would drop it from the model's tool result).
function withResetNotice(cu, result) {
  if (!cu.resetNotice) return result;
  cu.resetNotice = false;
  return {
    text: `${RESET_NOTICE}\n${result.text}`,
    content: [{ type: 'text', text: RESET_NOTICE }, ...result.content],
  };
}

function textOf(r) {
  return (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}
