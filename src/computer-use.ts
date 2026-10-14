// Host: owns the Codex REPL and the agent run. It launches the REPL from the
// installation with the launch recipe of ADR 0002, grants app approvals
// (ADR 0003), initialises sky in each new REPL, settles the reset notice in
// one place, checks that an agent run is active, carries the agent run's
// turn metadata on every cell, and signals turn_ended when the agent run
// ends. Cells run against the desktop and return MCP content blocks.
// Host-logic file: must never import anything from pi. Zero dependencies.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { locateInstallation, isRecord } from './installation.ts';
import { McpClient, StdioTransport } from '@earendil-works/pi-mcp';
import type { CallToolResult, ContentBlock, TextContent, ImageContent } from '@earendil-works/pi-mcp';

// The host's MCP request timeout rides above the cell's own timeout so the
// runtime's own timeout always fires first.
const HOST_TIMEOUT_MARGIN_MS = 10_000;
const RUNTIME_DEFAULT_TIMEOUT_MS = 30_000;
// turn_ended is a courtesy signal; a short timeout keeps run settle snappy.
const TURN_ENDED_TIMEOUT_MS = 5_000;
// The client reports the package's own version: its manifest is authored in
// this repo, so its shape is asserted, not probed.
const manifest: unknown = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!isRecord(manifest) || typeof manifest['version'] !== 'string') {
  throw new Error('package.json has no string version');
}
const version: string = manifest['version'];

// Set when the REPL was reset or relaunched; the next cell result opens
// with the notice, then the flag clears. Tests assert the exact text the
// model sees (reset-notice, reset-abort).
const RESET_NOTICE = 'Codex REPL state was reset: a new REPL was started.';

// Codex-style turn metadata carried by every cell: the key the runtime
// reads out of tools/call params._meta, arriving as nodeRepl.requestMeta
// inside the cell.
const TURN_META_KEY = 'x-codex-turn-metadata';

// Sky init, the same cell Codex's own Initialize runs: a bare dynamic import
// (the runtime resolves `@oai/sky` from its own module directories; only
// top-level static imports are rejected). Idempotent — the reset path and a
// relaunch after a crash must both be able to run it.
const SKY_INIT_CELL = `
if (!globalThis.sky) {
  const { sky } = await import("@oai/sky");
  globalThis.sky = sky;
}
`;

// The tools/call params of one cell: the cell plus, when the cell asks for
// its own timeout, `timeout_ms`, plus the run's turn metadata when one is
// active. An index signature, so the params pass as the MCP client's
// `Record<string, unknown>`; the named fields keep the shape explicit.
interface CellParams {
  [key: string]: unknown;
  name: string;
  arguments: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export class ComputerUse {
  constructor() {
    // The temporary directory shared by every REPL this package launches.
    this.#tmpDir = path.join(os.tmpdir(), 'pi-codex-repl');
    // One id per host session (per extension lifetime). The real pi session
    // id is injected on session start (SSOT: pi's SessionManager); this
    // random one is only the fallback until then.
    this.#sessionId = `pi-${process.pid}-${randomBytes(4).toString('hex')}`;
    // null until the first agent run begins.
    this.#turnId = null;
    this.#turnSeq = 0;
    this.#repl = null; // null, or the launched REPL's MCP client
    this.#skyReady = false;
    // Set when the REPL was reset or relaunched; the next cell result opens
    // with a reset notice, then the flag clears.
    this.#resetNotice = false;
    // True once the host has launched a REPL in this session at least once.
    this.#startedBefore = false;
  }

  // The pi session id names this host session to the runtime. Empty is not
  // a session id; the extension forwards only real ones.
  setSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  // A new agent run begins (each prompt): every cell in it carries this
  // fresh id.
  beginRun(): void {
    this.#turnSeq += 1;
    this.#turnId = `${this.#sessionId}-turn-${this.#turnSeq}-${randomBytes(3).toString('hex')}`;
  }

  // The agent run has ended — settled normally, or aborted: pi's abort
  // cancels a tool call or streaming request (GLOSSARY.md), it is not the
  // runtime's Escape stop. The
  // runtime is signalled the way Codex's own hooks do on Stop/Interrupt;
  // the signal is a courtesy, and for computer use it has no effect today
  // (docs/runtime-behavior.md). Best-effort: the goodbye
  // must never stall the run's settle path (pi awaits agent_settled
  // listeners), so it uses a short timeout and swallows errors — the
  // runtime's own timeout covers the rest. The run id is dropped first, so
  // the active-run gate applies at once even while the goodbye is in flight.
  async endRun(aborted: boolean = false): Promise<void> {
    const turnId = this.#turnId;
    if (!turnId) return; // no active agent run — nothing to signal
    this.#turnId = null;
    const repl = this.#repl;
    if (!repl) return; // no REPL — nothing to signal
    try {
      await repl.request('tools/call', {
        name: 'turn_ended',
        arguments: {
          hook_event_name: aborted ? 'Interrupt' : 'Stop',
          session_id: this.#sessionId,
          turn_id: turnId,
        },
      }, { timeoutMs: TURN_ENDED_TIMEOUT_MS });
    } catch {
      // REPL gone or busy: nothing to do — the signal is best-effort.
    }
  }

  // Run one model cell. `signal` is pi's AbortSignal, forwarded so the MCP
  // request cancels promptly on abort. Returns the runtime's content
  // blocks. A pending reset notice rides along as the FIRST block of
  // whatever the cell turns out to be — the content of a successful cell,
  // the thrown error's message when it fails — and is settled exactly once
  // either way.
  async runCell(code: string, { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<(TextContent | ImageContent)[]> {
    this.#assertAgentRunActive();
    this.#noticeIfRelaunched();
    return this.#settleResetNotice(async () => {
      await this.#ensureSky({ signal });
      const r = await this.#cell(code, { signal, timeoutMs });
      if (r?.isError) throw new Error(textOf(r) || 'REPL cell failed');
      // The runtime answers a cell with text and image blocks only
      // (docs/runtime-behavior.md); the MCP type is wider, so the narrowing
      // is asserted, not filtered — nothing is dropped at run time.
      return (r.content ?? []) as (TextContent | ImageContent)[];
    });
  }

  // Reset: close the REPL and start fresh; the next cell relaunches it,
  // re-initialises sky (#ensureSky), and its result carries a notice that
  // REPL state was reset.
  async reset(): Promise<void> {
    this.#assertAgentRunActive();
    await this.#shutDown();
    this.#skyReady = false;
    this.#resetNotice = true;
    this.#startedBefore = true;
  }

  // Kill the REPL process tree when the pi session ends. Returning the
  // promise lets pi's shutdown await the teardown.
  async close(): Promise<void> {
    await this.#shutDown();
    this.#skyReady = false;
    this.#resetNotice = false;
    this.#startedBefore = false;
  }

  // Detect a REPL that exited between calls (crash / killed / window closed)
  // and arrange for the next cell result to carry a reset notice. #launch
  // relaunches it; #ensureSky re-initialises sky.
  #noticeIfRelaunched(): void {
    if (!this.#repl && this.#startedBefore) {
      this.#resetNotice = true;
      this.#skyReady = false;
    }
    this.#startedBefore = true;
  }

  // Ready sky in a new REPL: the launch's fresh installation lookup has
  // already checked the module is present, so this only runs the init cell
  // (the same one Codex's own Initialize runs).
  async #ensureSky({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#skyReady) return;
    const r = await this.#cell(SKY_INIT_CELL, { timeoutMs: 30_000, signal });
    if (r?.isError) throw new Error(`sky init failed: ${textOf(r)}`);
    this.#skyReady = true;
  }

  // Run one cell (JavaScript) in the REPL. Returns the MCP result
  // { content: [...], isError } with text/image blocks passed through.
  // The call carries the agent run's Codex-style turn metadata in
  // params._meta (see #cellParams); the runtime surfaces it to the cell as
  // nodeRepl.requestMeta. Per `signal`, pi's AbortSignal cancels the MCP
  // request promptly instead of waiting for the cell to finish.
  async #cell(code: string, { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CallToolResult> {
    const repl = await this.#launch({ signal });
    const cellTimeoutMs = timeoutMs ?? RUNTIME_DEFAULT_TIMEOUT_MS;
    return repl.request<CallToolResult>('tools/call', this.#cellParams(code, { timeoutMs }), {
      signal,
      timeoutMs: cellTimeoutMs + HOST_TIMEOUT_MARGIN_MS,
    });
  }

  // The tools/call params of one cell. `timeout_ms` when the cell asks for
  // its own timeout; the run's turn metadata when one is active.
  #cellParams(code: string, { timeoutMs }: { timeoutMs?: number } = {}): CellParams {
    const arguments_: Record<string, unknown> = { code };
    if (timeoutMs != null) arguments_.timeout_ms = timeoutMs;
    return {
      name: 'js',
      arguments: arguments_,
      ...(this.#turnId ? { _meta: { [TURN_META_KEY]: { session_id: this.#sessionId, turn_id: this.#turnId } } } : {}),
    };
  }

  // Launch nothing until the first cell. Every launch performs a fresh
  // installation lookup, so Codex's configuration is re-read whenever a
  // REPL is launched — a Codex update mid-session is picked up.
  async #launch({ signal }: { signal?: AbortSignal } = {}): Promise<McpClient> {
    if (this.#repl) return this.#repl;
    const found = locateInstallation();
    if (!found.ok) {
      throw new Error(`Cannot start Codex REPL: missing ${found.missing.join('; ')}`);
    }
    // ADR 0002 launch recipe: the configured environment merged over the
    // current one, always with no arguments, minus the three variables that
    // route through the running Codex app, plus the analytics-off switch,
    // with temporary directories pointed at a writable location. Nothing is
    // persisted. inheritEnv: false makes this merged, cleaned object the
    // child's whole environment — StdioTransport would otherwise re-merge
    // process.env and bring the deleted variables back.
    const env = { ...process.env, ...found.env } as Record<string, string>;
    for (const k of ['SKY_CUA_NATIVE_PIPE', 'SKY_CUA_NATIVE_PIPE_DIRECTORY', 'CODEX_CLI_PATH']) {
      delete env[k];
    }
    env.NODE_REPL_DISABLE_ANALYTICS = '1';
    fs.mkdirSync(this.#tmpDir, { recursive: true });
    env.TMP = this.#tmpDir;
    env.TEMP = this.#tmpDir;

    const transport = new StdioTransport({ command: found.command, args: [], env, inheritEnv: false });
    const client = new McpClient({
      name: 'pi-codex-computer-use',
      version,
      capabilities: { elicitation: { form: {} } },
    });
    client.setRequestHandler('elicitation/create', async () => {
      // ADR 0003: grant every app approval with empty content.
      return { action: 'accept', content: {} };
    });
    // connect() starts the transport and runs the initialize handshake. Per
    // the MCP spec initialize cannot be cancelled, so instead of passing the
    // signal down we race the handshake against it and kill the newborn
    // process tree on abort — aborting the first call returns promptly.
    try {
      await raceAbort(client.connect(transport), signal);
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    }
    // Crash recovery: when the REPL dies (crash, window closed, killed), drop
    // the launch so the next cell relaunches it (a reset notice rides along,
    // see #noticeIfRelaunched).
    client.onClose(() => {
      if (this.#repl === client) this.#repl = null;
    });
    this.#repl = client;
    return this.#repl;
  }

  // Failing fast when no agent run is active: a cell or a reset outside a
  // prompt has no run id to carry, and every caller of the host module
  // should see the same single check.
  #assertAgentRunActive(): void {
    if (!this.#turnId) throw new Error('computer-use has no active agent run; start a prompt first');
  }

  // The one place the reset notice is settled for a cell, whatever its
  // outcome: the callback is the cell's work, and its result (success or
  // thrown error) carries the pending notice — leading the returned content
  // blocks on success, leading the error message on failure. One site, so
  // the two paths cannot drift apart. The extension passes successful
  // content through verbatim, so on success the notice must ride as a text
  // block — putting it in a thrown message alone would drop it from the
  // model's tool result. A transient failure between the REPL dying and the
  // relaunch happens once for one cell: settle first, then rethrow, so the
  // next cell is not told again that the state was reset.
  async #settleResetNotice(run: () => Promise<(TextContent | ImageContent)[]>): Promise<(TextContent | ImageContent)[]> {
    try {
      const content = await run();
      if (!this.#resetNotice) return content;
      this.#resetNotice = false;
      return [{ type: 'text', text: RESET_NOTICE }, ...content];
    } catch (err) {
      if (!this.#resetNotice) throw err;
      this.#resetNotice = false;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${RESET_NOTICE}\n${message}`);
    }
  }

  // Tear the REPL process tree down: drop the launch first (a failure or a
  // crash handler can then never see a live one), then close the client —
  // it tears down in-flight requests and closes the transport, which kills
  // the REPL process tree.
  async #shutDown(): Promise<void> {
    const repl = this.#repl;
    this.#repl = null;
    if (!repl) return;
    await repl.close();
  }

  #tmpDir: string;
  #sessionId: string;
  #turnId: string | null;
  #turnSeq: number;
  #repl: McpClient | null;
  #skyReady: boolean;
  #resetNotice: boolean;
  #startedBefore: boolean;
}

// Reject when `signal` aborts; otherwise settle with `promise`. Cleans the
// listener up on the promise path.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// The error message a failed cell result carries: the text blocks' joined
// text, which is where the runtime puts a failed cell's message.
function textOf(r: CallToolResult | null | undefined): string {
  return (r?.content ?? []).filter((c: ContentBlock): c is TextContent => c.type === 'text').map((c) => c.text).join('');
}
