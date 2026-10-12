// Tests that the reset notice reaches the model exactly once per new REPL.
// Seam: real pi SDK session with a faux provider scripting tool calls; the
// Codex REPL and everything behind the tools is the real runtime. The notice
// text is asserted as the literal text the model sees, not via the package's
// constant (docs/runtime-behavior.md, "Cells": the notice reads
// 'Codex REPL state was reset: a new REPL was started.').
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

import { readCodexConfig } from '../src/config.mjs';
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

const RESET_NOTICE_TEXT = 'Codex REPL state was reset: a new REPL was started.';
const countNotice = (text) => text.split(RESET_NOTICE_TEXT).length - 1;

// Fresh-REPL read-back: whether a pre-reset globalThis value survived (it
// must not) and whether sky is initialised again (it must be). The last
// line of the cell output is this JSON.
const FRESH_CHECK_CELL =
  "nodeRepl.write(JSON.stringify({ carried: globalThis.__noticeProbe ?? null, sky: typeof globalThis.sky }));";

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

withRuntime('the reset notice appears exactly once per new REPL', () => {
  // One directory for the whole suite, removed with every other test
  // directory when the test process exits (test/harness.js).
  const root = makeTempRoot('pi-cua-t7');

  it('criterion 1: after computer_use_reset a failing first cell leads with the notice and the next successful cell does not', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        // Prompt 1: establish a REPL with state the reset must drop.
        { kind: 'tool', name: 'computer_use', args: { code: "globalThis.__noticeProbe = 'carried over'; nodeRepl.write('warm');" } },
        { kind: 'text', text: 'warm done' },
        // Prompt 2: reset, then a first cell that FAILS, then a good cell.
        { kind: 'tool', name: 'computer_use_reset', args: {} },
        { kind: 'tool', name: 'computer_use', args: { code: "throw new Error('deliberate failure for the notice test');" } },
        { kind: 'tool', name: 'computer_use', args: { code: FRESH_CHECK_CELL } },
        { kind: 'text', text: 'finished' },
      ],
    });
    try {
      await session.prompt('warm the repl');
      const afterWarm = toolResults(session).length;
      await session.prompt('reset, then fail a cell, then a good cell');
      const reset = toolResults(session)[afterWarm];
      assert.ok(!reset.isError, `reset failed: ${toolContentTexts(reset)}`);
      const failed = toolResults(session)[afterWarm + 1];
      assert.ok(failed.isError, 'the first cell after reset did not fail');
      const failedText = toolContentTexts(failed);
      assert.ok(
        failedText.startsWith(`computer_use failed: ${RESET_NOTICE_TEXT}`),
        `failing cell error does not lead with the reset notice: ${failedText.slice(0, 160)}`,
      );
      assert.ok(countNotice(failedText) === 1, `notice appears ${countNotice(failedText)} times in the failed result`);
      const fresh = toolResults(session)[afterWarm + 2];
      assert.ok(!fresh.isError, `fresh-read cell failed: ${toolContentTexts(fresh)}`);
      const freshText = toolContentTexts(fresh);
      const lastLine = freshText.slice(freshText.lastIndexOf('\n') + 1);
      const parsed = JSON.parse(lastLine);
      assert.equal(parsed.carried, null, 'value survived reset on globalThis');
      assert.equal(parsed.sky, 'object', 'sky was not initialised in the new REPL');
      assert.ok(countNotice(freshText) === 0, `second cell still carries the notice: ${freshText.slice(0, 160)}`);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('criterion 2: after the REPL process is killed a failing first cell leads with the notice and the next successful cell does not', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        // Prompt 1: start the REPL (and put state on globalThis).
        { kind: 'tool', name: 'computer_use', args: { code: "globalThis.__noticeProbe = 'carried over'; nodeRepl.write('warm');" } },
        { kind: 'text', text: 'warm done' },
        // Prompt 2: first cell after the crash FAILS, then a good cell.
        { kind: 'tool', name: 'computer_use', args: { code: "throw new Error('deliberate failure for the notice test');" } },
        { kind: 'tool', name: 'computer_use', args: { code: FRESH_CHECK_CELL } },
        { kind: 'text', text: 'finished' },
      ],
    });
    try {
      const baseline = replProcPids();
      await session.prompt('warm the repl');
      const afterWarm = toolResults(session).length;
      const spawned = replProcPids().filter((pid) => !baseline.includes(pid));
      assert.ok(spawned.length >= 1, 'no node_repl process appeared after the first cell');
      // Kill the whole spawned set: the snapshot cannot tell the REPL top
      // process from its own helper child, and killing only the child leaves
      // the top process alive — the host sees no exit, no relaunch, no notice.
      for (const pid of spawned) await killTree(pid);
      await waitUntil(() => spawned.every((pid) => !replProcPids().includes(pid)), 5000);
      await session.prompt('fail a cell after the kill, then a good cell');
      const failed = toolResults(session)[afterWarm];
      assert.ok(failed.isError, 'the first cell after the kill did not fail');
      const failedText = toolContentTexts(failed);
      assert.ok(
        failedText.startsWith(`computer_use failed: ${RESET_NOTICE_TEXT}`),
        `failing cell error does not lead with the reset notice: ${failedText.slice(0, 160)}`,
      );
      assert.ok(countNotice(failedText) === 1, `notice appears ${countNotice(failedText)} times in the failed result`);
      const fresh = toolResults(session)[afterWarm + 1];
      assert.ok(!fresh.isError, `fresh-read cell failed: ${toolContentTexts(fresh)}`);
      const freshText = toolContentTexts(fresh);
      const lastLine = freshText.slice(freshText.lastIndexOf('\n') + 1);
      const parsed = JSON.parse(lastLine);
      assert.equal(parsed.carried, null, 'value survived the killed REPL on globalThis');
      assert.equal(parsed.sky, 'object', 'sky was not initialised in the relaunched REPL');
      assert.ok(countNotice(freshText) === 0, `second cell still carries the notice: ${freshText.slice(0, 160)}`);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('criterion 3: a successful first cell in a new REPL still starts with the reset notice', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('warm');" } },
        { kind: 'text', text: 'warm done' },
        { kind: 'tool', name: 'computer_use_reset', args: {} },
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('fresh ok');" } },
        { kind: 'text', text: 'finished' },
      ],
    });
    try {
      await session.prompt('warm the repl');
      const afterWarm = toolResults(session).length;
      await session.prompt('reset, then a good cell');
      const reset = toolResults(session)[afterWarm];
      assert.ok(!reset.isError, `reset failed: ${toolContentTexts(reset)}`);
      const fresh = toolResults(session)[afterWarm + 1];
      assert.ok(!fresh.isError, `fresh cell failed: ${toolContentTexts(fresh)}`);
      const freshText = toolContentTexts(fresh);
      assert.ok(freshText.startsWith(RESET_NOTICE_TEXT), `result does not start with the notice: ${freshText.slice(0, 160)}`);
      assert.ok(freshText.includes('fresh ok'), `cell output missing after the notice: ${freshText.slice(0, 200)}`);
      assert.ok(countNotice(freshText) === 1, `notice appears ${countNotice(freshText)} times in the result`);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });
});