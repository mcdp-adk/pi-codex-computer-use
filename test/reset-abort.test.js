// Acceptance tests for the reset, crash recovery, and abort criteria.
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

// The long cell writes a marker file (the externally observable start
// signal the abort test waits for), then sleeps. __cellRoot__ is substituted
// with the session's temp cwd; no process/globalThis state escapes.
const LONG_CELL_TPL = `
const __fs = await import('node:fs');
const __path = await import('node:path');
const __marker = __path.join(__cellRoot__, 'long-cell-running.marker');
__fs.writeFileSync(__marker, String(Date.now()));
await new Promise((r) => setTimeout(r, 60000));
nodeRepl.write('long cell finished');
`;

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

withRuntime('reset, crash recovery, and abort', () => {
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
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "globalThis.__t6marker = 'here'; nodeRepl.write('stored');" } },
        { kind: 'tool', name: 'computer_use_reset', args: {} },
        {
          kind: 'tool',
          name: 'computer_use',
          args: {
            code: "const __w = await globalThis.sky.list_windows(); nodeRepl.write(JSON.stringify({ marker: globalThis.__t6marker ?? null, windows: __w.length }));",
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
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        // Faux scripts are consumed per agent-loop continuation, not per
        // prompt: warmup tool + end-of-turn text belong to the warmup prompt,
        // the long cell + its text belong to the aborted prompt.
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('warmup done');" } },
        { kind: 'text', text: 'warmup done' },
        { kind: 'tool', name: 'computer_use', args: { code: LONG_CELL_TPL.replace('__cellRoot__', JSON.stringify(root)), timeout_ms: 400000 } },
        { kind: 'text', text: 'finished' },
      ],
    });
    let replProc = null;
    try {
      const baseline = replProcPids();
      // Warm the REPL first in the SAME session: the long cell must fight an
      // already-initialized REPL, not race its MCP + sky init.
      await session.prompt('warm the repl');
      const warmResults = toolResults(session);
      assert.ok(!warmResults[0]?.isError, `warmup cell failed: ${toolContentTexts(warmResults[0])}`);
      const baselineAfterWarmup = baseline;
      replProc = (await waitUntil(
        () => replProcPids().find((p) => !baseline.includes(p)) ?? null,
        30000,
      )) ?? null;
      assert.ok(replProc, 'no node_repl process appeared after the warmup cell');

      let toolStarted = false;
      let toolDone = false;
      const off = session.subscribe((event) => {
        if (event.type === 'tool_execution_start' && event.toolName === 'computer_use') toolStarted = true;
        if (event.type === 'tool_execution_end' && event.toolName === 'computer_use') toolDone = true;
      });
      // The long cell writes a marker file BEFORE sleeping: the externally
      // observable, repl-side signal that the cell is actually running —
      // tool_execution_start fires before MCP init would even finish, and
      // the marker only exists once the cell body is deep in its sleep.
      const marker = path.join(root, 'long-cell-running.marker');
      try {
        const promptPromise = session.prompt('run the long cell then abort');
        const sawStart = await waitUntil(() => toolStarted, 30000);
        assert.ok(sawStart, 'tool_execution_start never fired');
        assert.ok(
          await waitUntil(() => fs.existsSync(marker), 30000),
          'the long cell never wrote its marker - it was not running when we aborted',
        );
        assert.ok(!toolDone, 'the long cell already finished before the abort');
        const startedAt = Date.now();
        await session.abort();
        await promptPromise;
        const elapsedMs = Date.now() - startedAt;
        assert.ok(elapsedMs < 2000, `abort took ${elapsedMs}ms - not prompt`);
        // The aborted cell must come back as a cancellation error, not a
        // silent success — only the tool result observes that.
        const results = toolResults(session);
        const long = results.find((r) => toolContentTexts(r).includes('MCP request aborted')) ?? results[results.length - 1];
        assert.ok(long, 'no tool result recorded for the long cell');
        assert.ok(long.isError, `aborted cell returned success: ${toolContentTexts(long)}`);
        assert.match(toolContentTexts(long), /abort|cancel/i, `error text is not a cancellation: ${toolContentTexts(long)}`);
      } finally {
        off();
        fs.rmSync(marker, { force: true });
      }
    } finally {
      // Shutdown first: the extension's close() tears down the in-flight cell
      // request and kills the REPL tree — without it a sleeping cell keeps the
      // runner alive until the cell's timeout.
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
      if (replProc) await killTree(replProc);
      await waitUntil(() => !replProcPids().includes(replProc), 10000);
    }
  });
});