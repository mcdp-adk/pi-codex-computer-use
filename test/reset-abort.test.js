// Acceptance tests for issue #6: reset, crash recovery, and abort.
// Seam: real pi SDK session with a faux provider scripting tool calls; the
// Codex REPL and everything behind the tools is the real runtime.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

import { readCodexConfig } from '../src/config.mjs';
import { RESET_NOTICE } from '../src/repl.mjs';
import { makeTempRoot, createScriptedSession, toolResults, toolContentTexts } from './harness.js';

const hasRealRuntime = () => {
  try {
    const cfg = readCodexConfig();
    return !cfg.missing?.length && fs.existsSync(cfg.command);
  } catch {
    return false;
  }
};

const withRuntime = hasRealRuntime() ? describe : describe.skip;

// The extension instances pi loaded from this package.
function extensionOf(loader) {
  const exts = loader.getExtensions().extensions ?? [];
  const ours = exts.find((e) => e?.api?.computerUse) ?? exts[0];
  return ours?.api ?? null;
}

function killTree(pid) {
  return new Promise((resolve) => {
    const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    t.on('exit', resolve);
    t.on('error', resolve);
  });
}

async function waitUntil(pred, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

withRuntime('issue #6 acceptance: reset, recovery, and abort', () => {
  let root;

  before(() => {
    root = makeTempRoot('pi-cua-t6');
  });

  function procSnapshot() {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"',
      { encoding: 'utf8' },
    );
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [arr];
  }

  function replProcPids() {
    return procSnapshot().filter((p) => /node_repl/i.test(p.Name ?? '')).map((p) => p.ProcessId);
  }

  it('criterion 1: after computer_use_reset earlier globalThis values are gone and the next call can use sky', async () => {
    const { session, loader } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "globalThis.__t6marker = 'here'; nodeRepl.write('stored');" } },
        { kind: 'tool', name: 'computer_use_reset', args: {} },
        {
          kind: 'tool',
          name: 'computer_use',
          args: {
            code: "const __w = await globalThis.__sky.list_windows(); nodeRepl.write(JSON.stringify({ marker: globalThis.__t6marker ?? null, windows: __w.length }));",
          },
        },
        { kind: 'text', text: 'finished' },
      ],
    });
    try {
      await session.prompt('reset the REPL');
      const results = toolResults(session);
      assert.equal(results.length, 3, `expected 3 toolResults, got ${results.length}`);
      assert.ok(!results[0].isError, 'marker cell failed');
      assert.ok(!results[1].isError, 'reset call failed');
      assert.ok(!results[2].isError, `read-back cell failed: ${toolContentTexts(results[2])}`);
      const text = toolContentTexts(results[2]);
      const lastLine = text.slice(text.lastIndexOf('\n') + 1);
      const parsed = JSON.parse(lastLine);
      assert.equal(parsed.marker, null, 'value survived reset on globalThis');
      assert.ok(parsed.windows >= 0, 'sky was not ready after reset (list_windows failed to arrive)');
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('criterion 2: after the REPL process is killed, the next call succeeds and its result starts with a reset notice', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('first');" } },
        { kind: 'text', text: 'first prompt done' },
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('second');" } },
        { kind: 'text', text: 'finished' },
      ],
    });
    try {
      const baseline = replProcPids();
      await session.prompt('start the repl');
      const spawned = replProcPids().filter((pid) => !baseline.includes(pid));
      assert.ok(spawned.length >= 1, 'no node_repl process appeared after the first cell');
      // Kill the whole spawned set: the snapshot cannot tell the REPL top
      // process from its own helper child, and killing only the child leaves
      // the top process alive — the host sees no exit, no relaunch, no notice.
      for (const pid of spawned) await killTree(pid);
      await waitUntil(() => spawned.every((pid) => !replProcPids().includes(pid)), 5000);
      // Session is kept; the next scripted call must auto-restart the REPL
      // and its result must start with the reset notice.
      await session.prompt('call again after the kill');
      const results = toolResults(session);
      const second = results.find((r) => r.toolCallId && toolContentTexts(r).includes('second'))
        ?? results[results.length - 1];
      assert.ok(!second.isError, `second cell failed: ${toolContentTexts(second)}`);
      const text = toolContentTexts(second);
      assert.ok(text.startsWith(RESET_NOTICE), `result did not start with reset notice: ${text.slice(0, 120)}`);
      assert.ok(text.includes('second'), `cell output missing after notice: ${text.slice(0, 200)}`);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('criterion 3: aborting a long-running cell returns control to pi promptly', async () => {
    const { session, loader } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('cell started'); await new Promise(r => setTimeout(r, 30000)); nodeRepl.write('finished');", timeout_ms: 400000 } },
        { kind: 'text', text: 'finished' },
      ],
    });
    let replPid = null;
    try {
      const baseline = replProcPids();
      const promptPromise = session.prompt('run a long cell then abort');
      // Wait until a fresh node_repl process (the session's REPL) exists.
      await waitUntil(() => replProcPids().some((p) => !baseline.includes(p)), 30000);
      replPid = replProcPids().find((p) => !baseline.includes(p));
      // The tool only resolves when the request was actually sent; wait for
      // the cell to confirm it started (its first write flushes quickly),
      // then abort while the 30s sleep is still in flight.
      await waitUntil(() => toolResults(session).length >= 1 && toolContentTexts(toolResults(session)[0]).includes('cell started'), 30000);
      const startedAt = Date.now();
      await session.abort();
      await promptPromise;
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 5000, `abort took ${elapsedMs}ms - not prompt`);
      const results = toolResults(session);
      assert.ok(results.length >= 1, 'no toolResult recorded before abort');
    } finally {
      session.dispose();
      if (replPid) await killTree(replPid);
    }
  });
});