// REPL host: lazily launches the Codex node_repl MCP server, runs cells in it,
// auto-accepts app approvals (ADR 0003), and tears the process tree down.
// Host-logic file: must never import anything from pi. Zero dependencies.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readCodexConfig } from './config.mjs';
import { McpStdioClient } from './mcp-client.mjs';

const CALL_TIMEOUT_MS = 120000;

export const RESET_NOTICE = 'Codex REPL state was reset: a new REPL was started.';

export class ReplHost {
  constructor({ tmpDir } = {}) {
    this.tmpDir = tmpDir ?? path.join(os.tmpdir(), 'pi-codex-repl');
    this.client = null;
    this.stderr = '';
    // Escape stop: set to a run id by stopRun; cells for that run refuse to
    // run until a new run id no longer matches (the id mints per agent run).
    this._stoppedRunId = null;
  }

  get running() {
    return this.client?.proc != null;
  }

  // Launch nothing until the first cell. Returns true if the REPL started.
  async ensureStarted() {
    if (this.client?.proc) return true;
    const cfg = readCodexConfig();
    if (cfg.missing) {
      throw new Error(`Cannot start Codex REPL: missing ${cfg.missing.join('; ')}`);
    }
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const client = new McpStdioClient({ name: 'pi-codex-computer-use', version: '0.1.0' });
    client.setRequestHandler('elicitation/create', async () => {
      // ADR 0003: grant every app approval with empty content.
      return { action: 'accept', content: {} };
    });
    client.onStderr = (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    };
    await client.start({
      command: cfg.command,
      args: cfg.args,
      env: client.buildSpawnEnv(cfg.env),
    });
    this.client = client;
    return true;
  }

  // Run one cell (JavaScript) in the REPL. Returns the MCP result
  // { content: [...], isError } with text/image blocks passed through.
  // Per `turnMeta`, the cell script opens by publishing the run's Codex-style
  // turn metadata on globalThis (node_repl's `js` tool does not accept a
  // metadata argument — Codex's hooks pass it to `turn_ended` instead).
  // Per `signal`, pi's AbortSignal cancels the MCP request promptly instead
  // of waiting for the cell to finish.
  async runCell(code, { timeoutMs = CALL_TIMEOUT_MS, signal, turnMeta } = {}) {
    await this.ensureStarted();
    const cell = turnMeta
      ? `globalThis.__cua_turn_metadata = ${JSON.stringify({ session_id: turnMeta.session_id, run_id: turnMeta.run_id })};\n${code}`
      : code;
    const mcpArgs = { code: cell, timeout_ms: timeoutMs };
    const result = await this.client.callTool('js', mcpArgs, timeoutMs + 5000, signal);
    return result;
  }

  // Signal the runtime that a turn has ended (normal or aborted), the way
  // Codex's own hooks do on Stop/Interrupt. Escape-stop relies on it.
  // Best-effort: the goodbye must never stall the run's settle path (pi
  // awaits agent_settled listeners), so it uses a short timeout and swallows
  // transport errors — the runtime's own timeout covers the rest.
  async turnEnded(turnMeta, { hookEventName = 'Stop' } = {}) {
    if (!this.client || !turnMeta) return;
    try {
      await this.client.callTool('turn_ended', {
        hook_event_name: hookEventName,
        session_id: turnMeta.session_id,
        turn_id: turnMeta.run_id,
      }, 3000);
    } catch {
      // REPL gone or busy: the stop is already marked host-side; nothing to do.
    }
  }

  // Codex stops computer use for the rest of the run on Escape; the host
  // mirrors that here so a cell attempted after the stop surfaces the stop,
  // not a fresh run.
  stopRun(runId) {
    if (runId) this._stoppedRunId = runId;
  }

  _assertNotStopped(runId) {
    if (this._stoppedRunId && runId && this._stoppedRunId === runId) {
      throw new Error('Computer use is stopped for this agent run (Escape pressed). The next prompt may use computer use again.');
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    this._stoppedRunId = null;
    if (client) await client.close();
  }
}
