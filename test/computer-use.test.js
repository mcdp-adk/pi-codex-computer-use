// Acceptance tests for issue #2: run a cell in the Codex REPL from pi.
// Seam: real pi SDK session with a faux provider scripting tool calls; the
// Codex REPL and everything behind the tools is the real runtime.
// Scripted acceptance drives the two model-facing tools (computer_use,
// computer_use_reset); list_apps/take_screenshot live on as ComputerUse
// methods, invoked through cells from the extension, per issue #1.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { readCodexConfig } from '../src/config.mjs';
import { makeTempRoot, createScriptedSession, toolResults, toolContentTexts, toolContentImages } from './harness.js';
import { LIST_APPS_CELL, newScreenshotCell } from '../src/cells.mjs';

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

  it('criterion 1: scripted list-apps cell returns apps as text', async () => {
    const { session, loader } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: LIST_APPS_CELL } },
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
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('criterion 2: scripted screenshot cell returns an image; approval auto-granted (no prompt)', async () => {
    const { session, loader } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: newScreenshotCell(null) } },
        { kind: 'text', text: 'took screenshot' },
      ],
    });
    try {
      await session.prompt('capture the screen');
      const results = toolResults(session);
      assert.equal(results.length, 1, `expected 1 toolResult, got ${results.length}`);
      const images = toolContentImages(results[0]);
      assert.ok(images.length >= 1, `expected >=1 image in tool result, got ${images.length} (${toolContentTexts(results[0]).slice(0, 200)})`);
      assert.match(images[0].mimeType, /^image\//);
      assert.ok(images[0].data.length > 100, 'image data suspiciously small');
      assert.ok(!results[0].isError, 'screenshot tool result marked isError');
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('criterion 3: a value stored on globalThis in one call is read back in a later call', async () => {
    const { session, loader } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "globalThis.__cua_marker = 'persisted'; nodeRepl.write('stored');" } },
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write(globalThis.__cua_marker ?? 'missing');" } },
        { kind: 'text', text: 'finished' },
      ],
    });
    try {
      await session.prompt('store and read back a value');
      const results = toolResults(session);
      assert.equal(results.length, 2, `expected 2 toolResults, got ${results.length}`);
      const text = toolContentTexts(results[1]);
      assert.ok(text.includes('persisted'), `value did not persist between cells: ${text.slice(0, 200)}`);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('criterion 4: no REPL process exists before the first computer-use call in a session', async () => {
    const before = procSnapshot().filter((p) => /node_repl/i.test(p.Name ?? ''));
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('first cell');" } },
        { kind: 'text', text: 'done' },
      ],
    });
    try {
      // Extension loaded and tools registered: still no NEW REPL process.
      // (The live Codex desktop app may own unrelated node_repl procs; compare
      // by pid set, not raw count.)
      const mid = procSnapshot().filter((p) => /node_repl/i.test(p.Name ?? ''));
      assert.ok(
        mid.filter((p) => !before.some((b) => b.ProcessId === p.ProcessId)).length === 0,
        'unexpected new node_repl appeared while merely registering tools',
      );
      await session.prompt('go');
      const results = toolResults(session);
      assert.equal(results.length, 1, 'the scripted cell did not run');
      assert.ok(!results[0].isError, `first cell failed: ${toolContentTexts(results[0])}`);
      assert.ok(/first cell/.test(toolContentTexts(results[0])), 'cell output missing from tool result');
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('criterion 5: after the session ends, no process from the REPL tree remains', async () => {
    const before = procSnapshot().filter((p) => /node_repl/i.test(p.Name ?? ''));
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('first cell');" } },
        { kind: 'text', text: 'done' },
      ],
    });
    try {
      await session.prompt('go');
      // New node_repl processes this session spawned (baseline diff).
      const spawned = procSnapshot().filter(
        (p) => /node_repl/i.test(p.Name ?? '') && !before.some((b) => b.ProcessId === p.ProcessId),
      );
      assert.ok(spawned.length > 0, 'no new REPL process appeared on the first call');
      // session.dispose() does not emit session_shutdown; the harness helper
      // does what the CLI's quit path does (runtime dispose): it emits
      // session_shutdown so the extension's handler closes the REPL tree.
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      await new Promise((r) => setTimeout(r, 3000));
      const procs = procSnapshot().filter((p) => /node_repl/i.test(p.Name ?? ''));
      const leftovers = spawned.filter((p) => procs.some((q) => q.ProcessId === p.ProcessId));
      assert.equal(leftovers.length, 0, `REPL processes still alive: ${leftovers.map((p) => `${p.ProcessId}:${p.Name}`).join(', ')}`);
    } finally {
      session.dispose();
    }
  });

  it('criterion 6: REPL session runs a cell with the config untouched (launch recipe itself is asserted in repl-host.test.js)', async () => {
    const configPath = readCodexConfig().file;
    const before = fs.readFileSync(configPath);
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('env check');" } },
        { kind: 'text', text: 'done' },
      ],
    });
    try {
      await session.prompt('go');
      const results = toolResults(session);
      assert.ok(!results[0]?.isError, `cell failed: ${toolContentTexts(results[0])}`);
      assert.match(toolContentTexts(results[0]), /env check/);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
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
      if (src.includes(needle) || src.includes('pi-coding-agent')) {
        offenders.push(f);
      }
    }
    assert.deepEqual(offenders, [], `host files referencing pi: ${offenders.join(', ')}`);
  });
});