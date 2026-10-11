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
    this._hasRunBefore = false;
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
  // `signal`, when given, cancels the in-flight MCP request: the promise
  // rejects promptly with 'aborted by caller' instead of waiting for the
  // cell to finish.
  async runCell(code, { timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
    await this.ensureStarted();
    const result = await this.client.callTool('js', { code, timeout_ms: timeoutMs }, timeoutMs + 5000, signal);
    return result;
  }

  // If the REPL died (crash / killed / window closed), the next call
  // auto-restarts via ensureStarted, and sky is re-initialised by the
  // caller; `computerUse` prefixes the result with a reset notice.
  async runCellWithResetNotice(code, opts) {
    const wasRunning = this.running;
    const result = await this.runCell(code, opts);
    if (!wasRunning && this._hasRunBefore) {
      const text = (result?.content ?? []).filter((c) => c.type === 'text');
      if (result?.content) {
        result.content = [{ type: 'text', text: RESET_NOTICE }, ...result.content];
      } else {
        result.content = [{ type: 'text', text: RESET_NOTICE }];
      }
    }
    this._hasRunBefore = true;
    return result;
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (client) await client.close();
  }
}