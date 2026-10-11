// REPL host: lazily launches the Codex node_repl MCP server, runs cells in it,
// auto-accepts app approvals (ADR 0003), and tears the process tree down.
// Host-logic file: must never import anything from pi.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readCodexConfig } from './config.mjs';
import { McpClient } from '@earendil-works/pi-mcp';
import { StdioTransport } from '@earendil-works/pi-mcp';

// The host's MCP request timeout rides above the cell's own timeout so the
// runtime's own timeout always fires first (review fix 6).
const HOST_TIMEOUT_MARGIN_MS = 10_000;
const RUNTIME_DEFAULT_TIMEOUT_MS = 30_000;
// turn_ended is a courtesy signal; a short timeout keeps run settle snappy.
const TURN_ENDED_TIMEOUT_MS = 5_000;

export const RESET_NOTICE = 'Codex REPL state was reset: a new REPL was started.';

// Codex-style turn metadata carried by every cell (review fix 5): the key the
// runtime reads out of tools/call params._meta, arriving as
// nodeRepl.requestMeta inside the cell.
export const TURN_META_KEY = 'x-codex-turn-metadata';

export class ReplHost {
  constructor({ tmpDir } = {}) {
    this.tmpDir = tmpDir ?? path.join(os.tmpdir(), 'pi-codex-repl');
    this.client = null;
    this.transport = null;
    this.stderr = '';
  }

  get running() {
    return this.client != null;
  }

  // Launch nothing until the first cell. Returns true if the REPL started.
  async ensureStarted({ signal } = {}) {
    if (this.client) return true;
    const cfg = readCodexConfig();
    if (cfg.missing) {
      throw new Error(`Cannot start Codex REPL: missing ${cfg.missing.join('; ')}`);
    }
    // ADR 0002 launch recipe: the configured environment merged over the
    // current one, minus the three variables that route through the running
    // Codex app, plus the analytics-off switch, with temporary directories
    // pointed at a writable location. Nothing is persisted.
    const env = { ...process.env, ...cfg.env };
    for (const k of ['SKY_CUA_NATIVE_PIPE', 'SKY_CUA_NATIVE_PIPE_DIRECTORY', 'CODEX_CLI_PATH']) {
      delete env[k];
    }
    env.NODE_REPL_DISABLE_ANALYTICS = '1';
    fs.mkdirSync(this.tmpDir, { recursive: true });
    env.TMP = this.tmpDir;
    env.TEMP = this.tmpDir;

    const transport = new StdioTransport({ command: cfg.command, args: cfg.args ?? [], env });
    const client = new McpClient({
      name: 'pi-codex-computer-use',
      version: '0.1.0',
      capabilities: { elicitation: { form: {} } },
    });
    client.setRequestHandler('elicitation/create', async () => {
      // ADR 0003: grant every app approval with empty content.
      return { action: 'accept', content: {} };
    });
    // connect() starts the transport and runs the initialize handshake. Per
    // the MCP spec initialize cannot be cancelled, so instead of passing the
    // signal down we race the handshake against it and kill the newborn
    // process tree on abort — aborting the first call returns promptly (fix 2).
    try {
      await raceAbort(client.connect(transport), signal);
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    }
    this.client = client;
    this.transport = transport;
    return true;
  }

  // Run one cell (JavaScript) in the REPL. Returns the MCP result
  // { content: [...], isError } with text/image blocks passed through.
  // Per `turnMeta`, the call carries the run's Codex-style turn metadata in
  // params._meta; the runtime surfaces it to the cell as nodeRepl.requestMeta
  // (review fix 5 — no globalThis prefix needed).
  // Per `signal`, pi's AbortSignal cancels the MCP request promptly instead
  // of waiting for the cell to finish.
  async runCell(code, { timeoutMs, signal, turnMeta } = {}) {
    await this.ensureStarted({ signal });
    const cellTimeoutMs = timeoutMs ?? RUNTIME_DEFAULT_TIMEOUT_MS;
    const arguments_ = { code };
    if (timeoutMs != null) arguments_.timeout_ms = timeoutMs;
    const params = {
      name: 'js',
      arguments: arguments_,
      ...(turnMeta ? { _meta: { [TURN_META_KEY]: { session_id: turnMeta.session_id, turn_id: turnMeta.turn_id } } } : {}),
    };
    // The host never times out earlier than the cell itself (fix 6).
    return this.client.request('tools/call', params, {
      signal,
      timeoutMs: cellTimeoutMs + HOST_TIMEOUT_MARGIN_MS,
    });
  }

  // Signal the runtime that a turn has ended (normal or aborted), the way
  // Codex's own hooks do on Stop/Interrupt. Escape-stop relies on it.
  // Best-effort: the goodbye must never stall the run's settle path (pi
  // awaits agent_settled listeners), so it uses a short timeout and swallows
  // transport errors — the runtime's own timeout covers the rest.
  async turnEnded(turnMeta, { hookEventName = 'Stop' } = {}) {
    if (!this.client || !turnMeta) return;
    try {
      await this.client.request('tools/call', {
        name: 'turn_ended',
        arguments: {
          hook_event_name: hookEventName,
          session_id: turnMeta.session_id,
          turn_id: turnMeta.turn_id,
        },
      }, { timeoutMs: TURN_ENDED_TIMEOUT_MS });
    } catch {
      // REPL gone or busy: nothing to do — the signal is best-effort.
    }
  }

  async close() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.stderr = '';
    if (client) {
      // client.close() tears down in-flight requests and closes the
      // transport, which kills the REPL process tree.
      await client.close();
    } else if (transport) {
      await transport.close().catch(() => {});
    }
  }
}

// Reject when `signal` aborts; otherwise settle with `promise`. Cleans the
// listener up on the promise path.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}