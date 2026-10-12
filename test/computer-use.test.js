// Acceptance tests for running a cell in the Codex REPL from pi.
// Seam: real pi SDK session with a faux provider scripting tool calls; the
// Codex REPL and everything behind the tools is the real runtime.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  makeTempRoot,
  withRealRuntime,
  realCodexInstallation,
  createScriptedSession,
  procSnapshot,
  waitUntil,
  toolResults,
  toolContentTexts,
  toolContentImages,
} from './harness.js';

// Capture the first open window the runtime will capture: which windows exist,
// and whether they are minimized or browser windows (refused by the helper's
// URL policy), depends on the developer's desktop.
const SCREENSHOT_CELL = `
const errors = [];
for (const window of await sky.list_windows()) {
  try {
    const state = await sky.get_window_state({ window, include_screenshot: true, include_text: false });
    if (state.screenshots?.length) {
      nodeRepl.write(JSON.stringify({ window: window.title, screenshots: state.screenshots.length }));
      errors.length = 0;
      break;
    }
  } catch (error) {
    errors.push(window.title + ': ' + error.message);
  }
}
if (errors.length) throw new Error('no window could be captured: ' + errors.join('; '));
`;

withRealRuntime('run a cell in the Codex REPL from pi', () => {
  // One directory for the whole suite, removed with every other test
  // directory when the test process exits (test/harness.js).
  const root = makeTempRoot();
  fs.mkdirSync(root, { recursive: true });

  it('criterion 1: scripted list-apps cell returns apps as text', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: 'nodeRepl.write(JSON.stringify(await globalThis.sky.list_apps()));' } },
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
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: SCREENSHOT_CELL } },
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
    const { session } = await createScriptedSession({
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

  it('criterion 5: after the session ends, every descendant of the REPL process has exited', async () => {
    const before = procSnapshot();
    const livePids = () => new Set(procSnapshot().map((p) => p.ProcessId));
    const beforePids = livePids();
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('first cell');" } },
        { kind: 'text', text: 'done' },
      ],
    });
    try {
      await session.prompt('go');
      // The REPL top process(es) this session spawned (baseline diff).
      const procsNow = procSnapshot();
      const spawned = procsNow.filter(
        (p) => /node_repl/i.test(p.Name ?? '') && !beforePids.has(p.ProcessId),
      );
      assert.ok(spawned.length > 0, 'no new REPL process appeared on the first call');
      // Every descendant of the spawned REPL, whatever its name: walk the
      // parent->child edges of the full snapshot. Name-matching alone misses
      // helpers the runtime spawns under other names.
      const tree = new Set();
      const walk = (pid) => {
        if (tree.has(pid)) return;
        tree.add(pid);
        for (const child of procsNow.filter((p) => p.ParentProcessId === pid)) walk(child.ProcessId);
      };
      for (const p of spawned) walk(p.ProcessId);
      // session.dispose() does not emit session_shutdown; the harness helper
      // does what the CLI's quit path does (runtime dispose): it emits
      // session_shutdown so the extension's handler closes the REPL tree.
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      await waitUntil(() => [...tree].every((pid) => !livePids().has(pid)), 10000);
      const leftovers = [...tree].filter((pid) => livePids().has(pid));
      assert.equal(leftovers.length, 0, `REPL tree processes still alive: ${leftovers.join(', ')}`);
    } finally {
      session.dispose();
    }
  });

  it('criterion 6: REPL session runs a cell with the config untouched and the routing variables deleted', async () => {
    // The harness parsed the config path without the package's code.
    const real = realCodexInstallation();
    const configPath = real.file;
    const before = fs.readFileSync(configPath);
    // Plant the three app-routing variables with deliberately bogus values in
    // the TEST process env (the base the host merges the Codex config over).
    // If the host kept them, the cell would route through a pipe directory
    // that no process ever created and the call would fail (probed: with the
    // variables kept, sky never initialises and list_apps errors out).
    // Their deletion is therefore observable from inside a cell, behaviorally.
    const planted = {
      SKY_CUA_NATIVE_PIPE: '1',
      SKY_CUA_NATIVE_PIPE_DIRECTORY: '\\\\.\\pipe\\codex-computer-use-bogus-test',
      CODEX_CLI_PATH: 'C:\\bogus\\codex.exe',
    };
    const prevEnv = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    const expectedTmpDir = path.join(os.tmpdir(), 'pi-codex-repl');
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write(JSON.stringify({ tmpDir: nodeRepl.tmpDir, apps: (await globalThis.sky.list_apps()).slice(0, 1) }));" } },
        { kind: 'text', text: 'done' },
      ],
    });
    try {
      await session.prompt('go');
      const results = toolResults(session);
      assert.ok(!results[0]?.isError, `cell failed: ${toolContentTexts(results[0])}`);
      const observed = lastJsonObject(toolContentTexts(results[0]));
      // Temp directory pointed at the host's writable tmp dir (observable).
      assert.equal(
        path.resolve(observed.tmpDir),
        path.resolve(expectedTmpDir),
        `cell observed tmpDir ${observed.tmpDir}, expected the host tmp dir ${expectedTmpDir}`,
      );
      // Routing variables deleted: with them kept (bogus pipe, bogus cli path)
      // the call fails — success is the observable witness of their deletion.
      assert.ok(
        Array.isArray(observed.apps) && observed.apps.length > 0,
        'list_apps under planted bogus routing variables returned no apps',
      );
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
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

function lastJsonObject(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) {
      try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
    }
  }
  return {};
}