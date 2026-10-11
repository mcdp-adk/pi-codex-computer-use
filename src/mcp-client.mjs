#!/usr/bin/env node
// Minimal stdio JSON-RPC MCP client for the Codex node_repl server.
// Host-logic file: must never import anything from pi. Zero dependencies.
import { spawn } from 'node:child_process';

const INITIALIZE_TIMEOUT_MS = 15000;

export class McpStdioClient {
  constructor({ name, version }) {
    this.serverInfo = { name, version };
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.requestHandlers = new Map(); // method -> handler(params)
    this.buffer = '';
    this.exitPromise = null;
    this.stderrTail = '';
    this.onStderr = null;
  }

  // Exposed for testing: resolve the spawn environment for the server process
  // WITHOUT launching anything. See ADR 0002 for the env contract.
  buildSpawnEnv(configEnv) {
    const env = { ...process.env, ...configEnv };
    delete env.SKY_CUA_NATIVE_PIPE;
    delete env.SKY_CUA_NATIVE_PIPE_DIRECTORY;
    delete env.CODEX_CLI_PATH;
    env.NODE_REPL_DISABLE_ANALYTICS = '1';
    return env;
  }

  async start(spawnSpec) {
    const { command, args, env } = spawnSpec;
    if (this.proc) throw new Error('MCP client already started');
    // Stash the exact spawn environment for tests / introspection (ADR 0002).
    this.lastSpawnEnv = env ? { ...env } : undefined;
    this.exitPromise = new Promise((resolve) => {
      // store resolve; invoked on exit
      this._resolveExit = resolve;
    });
    this.proc = spawn(command, args ?? [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      if (this.onStderr) this.onStderr(chunk);
    });
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      if (this._resolveExit) this._resolveExit({ code, signal });
      const err = new Error(`mcp server exited (code=${code} signal=${signal}) ${this.stderrTail}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.proc.on('error', (err) => {
      const e = new Error(`failed to spawn mcp server: ${err.message}`);
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });

    await this._initialize();
  }

  async _initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: { form: {} } },
      clientInfo: this.serverInfo,
    }, INITIALIZE_TIMEOUT_MS);
    this.notify('notifications/initialized');
    return result;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // tolerate non-JSON lines
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.id === undefined || msg.id === null) return; // notification
    const isRequest = msg.method !== undefined;
    if (isRequest) {
      const handler = this.requestHandlers.get(msg.method);
      if (!handler) {
        this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params))
        .then((result) => this._send({ jsonrpc: '2.0', id: msg.id, result }))
        .catch((err) => this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } }));
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
  }

  _send(obj) {
    if (!this.proc) throw new Error('mcp server not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 120000, signal) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        // Best-effort MCP cancellation; the server may ignore it.
        try {
          if (this.proc) this.notify('notifications/cancelled', { requestId: id, reason: 'client aborted' });
        } catch {}
        reject(new Error('aborted by caller'));
      };
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); cleanup(); resolve(v); },
        reject: (e) => { clearTimeout(timer); cleanup(); reject(e); },
      });
      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          return onAbort();
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    // An already-aborted signal rejected the promise above; do not send.
    if (signal?.aborted) return p;
    this._send({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  notify(method, params) {
    this._send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  setRequestHandler(method, handler) {
    this.requestHandlers.set(method, handler);
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return result.tools ?? [];
  }

  async callTool(name, args, timeoutMs = 120000, signal) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs, signal);
  }

  async close() {
    if (this.proc) {
      const proc = this.proc;
      proc.removeAllListeners('error');
      try { proc.stdin.end(); } catch {}
      // Give the server a moment to exit cleanly, then kill the tree.
      const exited = await Promise.race([
        new Promise((r) => {
          if (!this.proc) return r(true);
          this.proc.once('exit', () => r(true));
        }),
        new Promise((r) => setTimeout(() => r(false), 3000)),
      ]);
      if (!exited && proc.pid) {
        // kill the whole process tree (Windows)
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
        this.proc = null;
      }
    }
  }
}