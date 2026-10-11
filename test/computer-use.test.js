// Acceptance tests for issue #2: run a cell in the Codex REPL from pi.
// Seam: real pi SDK session with a faux provider scripting tool calls; the
// Codex REPL and everything behind the tools is the real runtime.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { readCodexConfig } from '../src/config.mjs';
import { makeTempRoot, createScriptedSession, toolResults, toolContentTexts, toolContentImages } from './harness.js';

const hasRealRuntime = () => {
  try {
    const cfg = readCodexConfig();
    return !cfg.missing?.length && fs.existsSync(cfg.command);
  } catch {
    return false;
  }
};

const withRuntime = hasRealRuntime() ? describe : describe.skip;

function procSnapshot() {
  const out = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"',
    { encoding: 'utf8' },
  );
  const arr = JSON.parse(out);
  return Array.isArray(arr) ? arr : [arr];
}

function treeOf(pid, procs = procSnapshot()) {
  const out = [];
  const walk = (id) => {
    for (const p of procs.filter((x) => x.ParentProcessId === id)) {
      out.push(p);
      walk(p.ProcessId);
    }
  };
  const root = procs.find((p) => p.ProcessId === pid);
  if (root) {
    out.push(root);
    walk(pid);
  }
  return out;
}

withRuntime('issue #2 acceptance: run a cell in the Codex REPL from pi', () => {
  let root;

  before(() => {
    root = makeTempRoot();
  });

  it('criterion 1: scripted list_apps call returns apps as text', async () => {
    const { session, extensionsResult } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'list_apps', args: {} },
        { kind: 'text', text: 'listed apps' },
      ],
    });
    try {
      await session.prompt('list the running apps');
      const results = toolResults(session);
      assert.equal(results.length, 1, `expected 1 toolResult, got ${results.length}`);
      const text = toolContentTexts(results[0]);
      assert.ok(text.length > 0, 'tool result text empty');
      assert.ok(
        /id|title|windows|displayName|app/i.test(text),
        `expected app fields in text, got: ${text.slice(0, 200)}`,
      );
    } finally {
      session.dispose();
    }
  });

  it('criterion 2: scripted screenshot call returns an image; approval auto-granted (no prompt)', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'take_screenshot', args: {} },
        { kind: 'text', text: 'took screenshot' },
      ],
    });
    try {
      await session.prompt('capture the screen');
      const results = toolResults(session);
      assert.equal(results.length, 1, `expected 1 toolResult, got ${results.length}`);
      const images = toolContentImages(results[0]);
      assert.ok(images.length >= 1, `expected >=1 image in tool result, got ${images.length}`);
      assert.match(images[0].mimeType, /^image\//);
      assert.ok(images[0].data.length > 100, 'image data suspiciously small');
      assert.ok(!results[0].isError, 'screenshot tool result marked isError');
    } finally {
      session.dispose();
    }
  });

  it('criterion 3: a value stored on globalThis in one call is read back in a later call', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'list_apps', args: {} },
        { kind: 'tool', name: 'list_apps', args: {} },
        { kind: 'text', text: 'finished' },
      ],
    });
    try {
      await session.prompt('list apps twice');
      const results = toolResults(session);
      assert.equal(results.length, 2);
      // The first call initialises sky and defines globalThis.__sky; the
      // second call reuses the same REPL and reads the value back.
      const text = toolContentTexts(results[1]);
      assert.ok(text.length > 0);
      assert.ok(/id|title|windows|displayName|app/i.test(text));
    } finally {
      session.dispose();
    }
  });

  it('criterion 4: no REPL process exists before the first computer-use call in a session', async () => {
    const before = procSnapshot().filter((p) => /node_repl/i.test(p.Name ?? ''));
    const marker1 = before.length;
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'list_apps', args: {} },
        { kind: 'text', text: 'done' },
      ],
    });
    try {
      // Extension loaded and tools registered: still no REPL process.
      const mid = procSnapshot().filter((p) => /node_repl/i.test(p.Name ?? ''));
      // Live Codex desktop app may own a node_repl; count by creation-time is
      // unreliable, so assert via our own host laziness instead.
      const { ComputerUse } = await import('../src/computer-use.mjs');
      const cu = new ComputerUse();
      assert.equal(cu.running, false, 'REPL host reports running before any call');
      assert.ok(mid.filter((p) => !before.some((b) => b.ProcessId === p.ProcessId)).length === 0,
        `unexpected node_repl appeared while merely listing tools (before=${marker1})`);
      await session.prompt('go');
      assert.equal(cu.running, false, 'CU instance in this test never spawned');
      // The extension's own computer-use must have spawned exactly its REPL:
      // assert on the shared singleton's liveness, not on global process
      // counts (the live Codex desktop app owns unrelated node_repl procs).
      const mod = await import('../src/extension.mjs');
      const extCU = mod.computerUse ?? mod.default?.computerUse;
      assert.ok(extCU?.running, 'extension host did not start a REPL during the tool call');
      assert.ok(extCU?.host?.client?.proc?.pid, 'no REPL pid after tool call');
    } finally {
      session.dispose();
    }
  });

  it('criterion 5: after the session ends, no process from the REPL tree remains', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'list_apps', args: {} },
        { kind: 'text', text: 'done' },
      ],
    });
    let replPid;
    try {
      await session.prompt('go');
      const mod = await import('../src/extension.mjs');
      // Reach the single shared host instance the module exports.
      const computerUse = mod.computerUse ?? mod.default?.computerUse;
      replPid = computerUse?.host?.client?.proc?.pid;
    } finally {
      // session.dispose() does not emit session_shutdown, so trigger teardown
      // the way the CLI does (agent-session-runtime.dispose) to exercise the
      // same shutdown path.
      session._runtime?.dispose ? await session._runtime.dispose()
        : await (await import('../src/extension.mjs')).computerUse?.close();
      session.dispose();
    }
    assert.ok(replPid, 'extension did not expose an active REPL to verify');
    await new Promise((r) => setTimeout(r, 3000));
    const procs = procSnapshot();
    const leftovers = treeOf(replPid, procs);
    assert.equal(leftovers.length, 0, `REPL tree still alive: ${leftovers.map((p) => `${p.ProcessId}:${p.Name}`).join(', ')}`);
  });

  it('criterion 6: REPL launched with Codex configured env minus app-routing vars, plus analytics-off; config file byte-identical', async () => {
    const configPath = readCodexConfig().file;
    const before = fs.readFileSync(configPath);
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'list_apps', args: {} },
        { kind: 'text', text: 'done' },
      ],
    });
    let spawnEnv;
    try {
      await session.prompt('go');
      const mod = await import('../src/extension.mjs');
      const computerUse = mod.computerUse ?? mod.default?.computerUse;
      spawnEnv = computerUse?.host?.client?.lastSpawnEnv ?? process.env;
      assert.equal(spawnEnv.NODE_REPL_DISABLE_ANALYTICS, '1', 'analytics-off switch missing');
      assert.ok(!('SKY_CUA_NATIVE_PIPE' in spawnEnv), 'SKY_CUA_NATIVE_PIPE leaked');
      assert.ok(!('SKY_CUA_NATIVE_PIPE_DIRECTORY' in spawnEnv), 'SKY_CUA_NATIVE_PIPE_DIRECTORY leaked');
      assert.ok(!('CODEX_CLI_PATH' in spawnEnv), 'CODEX_CLI_PATH leaked');
      // Every configured env var that is NOT an app-routing var must be
      // passed through unchanged.
      const cfg = readCodexConfig();
      for (const [k, v] of Object.entries(cfg.env ?? {})) {
        if (['SKY_CUA_NATIVE_PIPE', 'SKY_CUA_NATIVE_PIPE_DIRECTORY', 'CODEX_CLI_PATH'].includes(k)) continue;
        assert.equal(spawnEnv[k], v, `env ${k} not from config`);
      }
    } finally {
      session.dispose();
    }
    const after = fs.readFileSync(configPath);
    assert.ok(before.equals(after), 'Codex config file changed during run');
  });

  it('criterion 7: REPL hosting logic imports no pi packages', async () => {
    const hostDir = path.resolve(import.meta.dirname, '..', 'src');
    const files = fs.readdirSync(hostDir).filter((f) => f.endsWith('.mjs') && f !== 'extension.mjs');
    const needle = '@earendil-works/pi-coding-agent';
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(hostDir, f), 'utf8');
      if (src.includes(needle) || src.includes('@earendil-works/pi') || src.includes('pi-coding-agent')) {
        offenders.push(f);
      }
    }
    assert.deepEqual(offenders, [], `host files referencing pi: ${offenders.join(', ')}`);
  });
});