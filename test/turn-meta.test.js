// Tests for issue #5: the per-agent-run Escape stop mechanism + the turn
// metadata each computer-use cell carries. The physical key press itself is
// owner-manual (it cannot be scripted); what we verify here is the mechanism:
// every cell carries Codex-style turn metadata, the end of an agent run
// (settled or aborted) sends turn_ended to the runtime, and an Escape
// ("escape stop") blocks the rest of the run while the next prompt runs
// computer use again.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The host is the MCP layer. Our ComputerUse runs its real logic on top; the
// stub answers the sky-init cell (so ensureSky succeeds with no real Codex
// install) and records what each later cell carried.
function makeMcpLayer() {
  return {
    cells: [], // every host.runCell call, in order
    turnEndedCalls: [], // every host.turnEnded call { turnMeta, hookEventName }
    closed: 0,
    _running: false,
    _stoppedRunId: null,
    get running() { return this._running; },

    async runCell(code, opts = {}) {
      this._running = true;
      this.cells.push({ code, ...opts });
      if (code.includes('globalThis.__sky')) {
        // Answer the sky-init cell so ensureSky passes without a real runtime.
        return { text: '[sky] loaded', content: [{ type: 'text', text: '[sky] loaded' }] };
      }
      return { text: '[computer-use] ok', content: [{ type: 'text', text: '[computer-use] ok' }] };
    },

    // Escape stop: refuse to run cells for this run id until the next run.
    stopRun(runId) {
      this._stoppedRunId = runId;
    },
    // Escape stop: refuse cells for a stopped run — or a cell with no run id
    // at all, since that's also what the rest of the stopped run sends.
    _assertNotStopped(runId) {
      if (this._stoppedRunId && (!runId || this._stoppedRunId === runId)) {
        throw new Error('Computer use is stopped for this agent run (Escape pressed). The next prompt may use computer use again.');
      }
    },

    // Codex convention: every end-of-run maps to a hook_event_name; the host
    // forwards it as the turn_ended MCP call (ReplHost does this in reality).
    async turnEnded(turnMeta, { hookEventName } = {}) {
      this.turnEndedCalls.push({ turnMeta, hookEventName });
    },

    async close() {
      this._running = false;
      this.closed++;
      this._stoppedRunId = null;
    },
  };
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

async function startExtension() {
  const { ComputerUse } = await import(new URL('../src/computer-use.mjs', import.meta.url).href);
  const { TurnMeta } = await import(new URL('../src/turn-meta.mjs', import.meta.url).href);
  const mcp = makeMcpLayer();
  const computerUse = new ComputerUse({ host: mcp }); // real ComputerUse, MCP layer stubbed
  const mod = await import(new URL(`../src/extension.mjs?tm=${Date.now()}-${Math.random()}`, import.meta.url).href);
  const pi = makePiStub();
  const api = mod.default(pi, { computerUse, turnMeta: new TurnMeta() });
  const modelCell = () => mcp.cells[mcp.cells.length - 1];
  const fireAgentSettled = (aborted) =>
    pi.fire('agent_settled', { type: 'agent_settled', aborted, turnId: api.turnMeta.runId }, {});
  return { pi, mcp, computerUse, api, modelCell, fireAgentSettled };
}

describe('issue #5: stop computer use with the physical Escape key (mechanism)', () => {
  it('each model cell carries turn metadata naming its session and agent run', async () => {
    const { pi, api, modelCell } = await startExtension();

    pi.fire('agent_start', {}, {});
    const runId = api.turnMeta.runId;
    assert.ok(runId, 'run id is live after agent_start');

    await pi.tools.computer_use.execute('tc-1', { code: '42' });
    assert.deepEqual(
      modelCell().turnMeta,
      { session_id: api.turnMeta.sessionId, run_id: runId },
      'every cell carries Codex-style turn metadata',
    );
  });

  it('an aborted agent run sends turn_ended (Interrupt) and stops computer use in that run; the next prompt recovers', async () => {
    const { pi, mcp, api, modelCell, fireAgentSettled } = await startExtension();

    pi.fire('agent_start', {}, {});
    const runId = api.turnMeta.runId;
    await pi.tools.computer_use.execute('tc-2', { code: '42' });
    assert.equal(mcp.cells.length, 2, 'the cell ran (sky init + model cell)');
    const cellsBeforeStop = mcp.cells.length;

    // Physical Escape in the terminal surfaces as an abort at the end of the
    // agent run. The handler: stop this run's computer use + turn_ended.
    await fireAgentSettled(true);
    assert.equal(mcp.turnEndedCalls.length, 1, 'the abort sends turn_ended');
    assert.deepEqual(mcp.turnEndedCalls[0].turnMeta, { session_id: api.turnMeta.sessionId, run_id: runId });
    assert.equal(mcp.turnEndedCalls[0].hookEventName, 'Interrupt', 'an aborted run maps to Interrupt, as Codex does');

    // The rest of the run is stopped at the tool surface.
    const blocked = await pi.tools.computer_use.execute('tc-3', { code: '43' });
    assert.ok(blocked.isError, 'after Escape the cell surfaces the stop as the tool result');
    assert.match(blocked.content[0].text, /stopped for this agent run/i);
    assert.equal(mcp.cells.length, cellsBeforeStop, 'the blocked cell never reached the host');

    // The next prompt starts a fresh run and computer use works again.
    pi.fire('agent_start', {}, {});
    assert.notEqual(api.turnMeta.runId, runId, 'the next run has a fresh id');
    const next = await pi.tools.computer_use.execute('tc-4', { code: '44' });
    assert.ok(!next.isError, 'the next prompt may use computer use again');
    assert.equal(modelCell().turnMeta.run_id, api.turnMeta.runId);
  });

  it('a settled (non-aborted) agent run also sends turn_ended (Stop), without stopping anything', async () => {
    const { pi, mcp, api, fireAgentSettled } = await startExtension();

    pi.fire('agent_start', {}, {});
    const runId = api.turnMeta.runId;
    await pi.tools.computer_use.execute('tc-5', { code: '42' });

    await fireAgentSettled(false);
    assert.equal(mcp.turnEndedCalls.length, 1);
    assert.equal(mcp.turnEndedCalls[0].turnMeta.run_id, runId);
    assert.equal(mcp.turnEndedCalls[0].hookEventName, 'Stop', 'a settled run maps to Stop');

    // Nothing stopped: the next run's cells flow normally.
    pi.fire('agent_start', {}, {});
    const res = await pi.tools.computer_use.execute('tc-6', { code: '42' });
    assert.ok(!res.isError, 'a settled run does not stop the next one');
  });

  it('an abort with no active run id on the event still stops the current run (fallback)', async () => {
    const { pi, mcp, api, fireAgentSettled } = await startExtension();

    pi.fire('agent_start', {}, {});
    await pi.tools.computer_use.execute('tc-7', { code: '42' });
    // Fire agent_settled with no turnId: Escape in a real session must still
    // stop the live run. TurnMeta falls back to the live run id.
    await pi.fire('agent_settled', { type: 'agent_settled', aborted: true }, {});
    assert.equal(mcp.turnEndedCalls.length, 1, 'turn_ended fired with the fallback id');
    assert.equal(mcp.turnEndedCalls[0].hookEventName, 'Interrupt');
    assert.ok(mcp.turnEndedCalls[0].turnMeta.run_id, 'endRun consumed and passed the live run id');

    const blocked = await pi.tools.computer_use.execute('tc-8', { code: '43' });
    assert.ok(blocked.isError, 'no-turnId abort still stops the run');
    assert.match(blocked.content[0].text, /stopped for this agent run/i);
  });

  it('without a live run (no agent_start yet), tools report no active run', async () => {
    const { pi, mcp } = await startExtension();
    const res = await pi.tools.computer_use.execute('tc-9', { code: '42' });
    assert.ok(res.isError, 'a cell with no active run is an error, not a bare cell');
    assert.match(res.content[0].text, /no active agent run/i);
    assert.equal(mcp.cells.length, 0, 'no cell — not even sky init — reached the REPL');
  });

  it('session_shutdown closes the REPL host and it is awaited by pi', async () => {
    const { pi, mcp } = await startExtension();
    pi.fire('agent_start', {}, {});
    await pi.tools.computer_use.execute('tc-10', { code: '42' }); // starts the REPL
    assert.equal(mcp.running, true, 'host running after a cell');
    await pi.fire('session_shutdown', { type: 'session_shutdown' }, {});
    assert.equal(mcp.closed, 1, 'session_shutdown tore the REPL tree down and the host was awaited');
    assert.equal(mcp.running, false, 'host no longer running');
  });
});
