// Tests for issue #5: the per-agent-run Escape stop mechanism + the turn
// metadata each computer-use cell carries. The physical key press itself is
// owner-manual (cannot be scripted); what we CAN verify in a test is the
// mechanism: a stop blocks the rest of the run, a new run clears it, and every
// cell carries turn metadata naming its agent run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { ComputerUse } from '../src/computer-use.mjs';
import { TurnMeta } from '../src/turn-meta.mjs';

function extUrl() {
  return pathToFileURL(path.resolve(import.meta.dirname, '..', 'src', 'extension.mjs'));
}

function makePiStub() {
  return {
    handlers: {},
    tools: {},
    registerTool(t) { this.tools[t.name] = t; },
    on(event, handler) { this.handlers[event] = handler; },
    fire(event, payload, ctx) { return this.handlers[event]?.(payload ?? {}, ctx ?? {}); },
  };
}

describe('issue #5: stop computer use with the physical Escape key (mechanism)', () => {
  it('turn metadata: new session id per TurnMeta, fresh run id per agent run', () => {
    const a = new TurnMeta();
    const b = new TurnMeta();
    assert.notEqual(a.sessionId, b.sessionId, 'distinct sessions get distinct ids');

    const run1 = a.beginRun();
    const meta1 = a.cellMeta();
    assert.equal(meta1.session_id, a.sessionId);
    assert.equal(meta1.run_id, run1);
    const run2 = a.beginRun();
    assert.notEqual(run1, run2, 'each agent run gets a unique run id');
  });

  it('an Escape stop blocks the rest of the run; the next run is unaffected', async () => {
    const pi = makePiStub();
    const mod = await import(extUrl().href + '?t5=' + Date.now());
    const computerUse = new ComputerUse();
    const turnMeta = new TurnMeta();
    // Drive the extension against our own host+meta instances by monkey-binding
    const ret = mod.default(pi);
    const runId = turnMeta.beginRun();

    // First: no stop yet, so a stopped-assert passes.
    assert.doesNotThrow(() => computerUse._assertNotStopped(runId));

    // Simulate Escape / abort: stop the current run.
    computerUse.stopRun(runId);

    // Any further computer use in this run throws the stop.
    assert.throws(
      () => computerUse._assertNotStopped(runId),
      /stopped for this agent run/i,
      'a stopped run must block further computer use',
    );

    // The next prompt (new run, fresh run id) is NOT stopped.
    const nextRun = turnMeta.beginRun();
    assert.doesNotThrow(() => computerUse._assertNotStopped(nextRun), 'next run clears the stop');
  });

  it('the abort handler stops the current run; agent_end clears the run', async () => {
    const pi = makePiStub();
    const mod = await import(extUrl().href + '?t5b=' + Date.now());
    const ret = mod.default(pi);

    // Begin a run via agent_start, then ensure the run id is live.
    pi.fire('agent_start', {}, {});
    assert.ok(mod.turnMeta.runActive, 'run should be active after agent_start');
    const runId = mod.turnMeta.runId;

    // Escape press -> pi surfaces abort -> our handler stops the run.
    pi.fire('abort', {}, {});
    assert.throws(
      () => mod.computerUse._assertNotStopped(runId),
      /stopped for this agent run/i,
    );

    // New prompt -> new run -> the stop no longer applies.
    pi.fire('agent_end', {}, {});
    assert.equal(mod.turnMeta.runId, null, 'agent_end ends the run');
    pi.fire('agent_start', {}, {});
    assert.ok(mod.turnMeta.runId !== runId, 'next prompt starts a fresh run');
    assert.doesNotThrow(() => mod.computerUse._assertNotStopped(mod.turnMeta.runId));
  });

  it('execute() for a stopped run returns the stop as the tool result', async () => {
    const pi = makePiStub();
    const mod = await import(extUrl().href + '?t5c=' + Date.now());
    mod.default(pi);

    pi.fire('agent_start', {}, {});
    pi.fire('abort', {}, {}); // Escape

    const res = await pi.tools.list_apps.execute();
    assert.ok(res.isError, 'stopped run surfaces as an error result, not a hang');
    assert.match(res.content[0].text, /stopped for this agent run/i);
  });
});
