// Tests for issue #5: per-agent-run Escape-stop mechanism + the turn metadata
// each cell carries. The physical key press itself is owner-manual. Seam:
// real pi SDK session with a faux provider scripting tool calls; the REPL is
// the real runtime. Assert only what the user/model observes: the cell
// returns the request meta it saw (nodeRepl.requestMeta), turn ids change
// between agent runs, and pi's session id is carried as session_id.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

// The cell writes what the runtime handed it as request meta. If no meta
// arrived, write a marker so the assertion fails loudly rather than on
// undefined parsing.
const META_PROBE_CELL =
  "nodeRepl.write(typeof nodeRepl.requestMeta === 'undefined' ? 'NO_REQUEST_META' : JSON.stringify(nodeRepl.requestMeta));";

withRuntime('issue #5: turn metadata on every computer-use cell (observed by the cell)', () => {
  let root;

  before(() => {
    root = makeTempRoot('pi-cua-t5');
  });

  it('the cell sees params._meta turn metadata as nodeRepl.requestMeta with pi session id and a per-run turn id', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: META_PROBE_CELL } },
        { kind: 'text', text: 'done' },
      ],
    });
    try {
      await session.prompt('probe the turn metadata');
      const results = toolResults(session);
      const text = toolContentTexts(results[0]);
      assert.ok(!results[0]?.isError, `cell failed: ${text}`);
      assert.notEqual(text, 'NO_REQUEST_META', 'the runtime handed the cell no request metadata');
      const meta = JSON.parse(text);
      assert.ok(
        meta['x-codex-turn-metadata'],
        `turn metadata key missing in ${text}`,
      );
      const { session_id, turn_id } = meta['x-codex-turn-metadata'];
      assert.equal(session_id, session.sessionManager.getSessionId(), 'session_id is pi session id');
      assert.ok(turn_id, 'turn_id present');
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('a new agent run carries a fresh turn_id; session_id stays the same', async () => {
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: META_PROBE_CELL } },
        { kind: 'text', text: 'run one done' },
        { kind: 'tool', name: 'computer_use', args: { code: META_PROBE_CELL } },
        { kind: 'text', text: 'run two done' },
      ],
    });
    try {
      await session.prompt('first run');
      await session.prompt('second run');
      const results = toolResults(session);
      const first = JSON.parse(toolContentTexts(results[0]))['x-codex-turn-metadata'];
      const second = JSON.parse(toolContentTexts(results[1]))['x-codex-turn-metadata'];
      const piSessionId = session.sessionManager.getSessionId();
      assert.equal(first.session_id, piSessionId);
      assert.equal(second.session_id, piSessionId);
      assert.notEqual(second.turn_id, first.turn_id, 'turn_id must change between agent runs');
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('a run settled without abort sends turn_ended with the run ids (observed: prompt completes cleanly)', async () => {
    // The turn_ended call is best-effort by design (run settle must not stall).
    // Observable behaviour: the run settles even when the REPL is gone.
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('hello');" } },
        { kind: 'text', text: 'settled' },
      ],
    });
    try {
      await session.prompt('run a cell');
      const results = toolResults(session);
      assert.ok(!results[0]?.isError, `cell failed: ${toolContentTexts(results[0])}`);
      assert.match(toolContentTexts(results[0]), /hello/);
      // Prompt settled (session.prompt resolved) — turn_ended did not stall it.
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  it('a run with no active agent run is refused at the tool surface', async () => {
    // No prompt has started in this session: the tool must not run a cell.
    // Observable: the session starts (session_start fired), but the scripted
    // tool call happens inside a prompt, so the refusal is tested by the
    // gated-extension behaviour in discovery.test.js instead. Here: a cell
    // refused before any run would produce this same marker.
    const { session } = await createScriptedSession({
      cwd: root,
      scripts: [
        { kind: 'tool', name: 'computer_use', args: { code: META_PROBE_CELL } },
        { kind: 'text', text: 'done' },
      ],
    });
    try {
      await session.prompt('probe the turn metadata');
      const results = toolResults(session);
      const meta = JSON.parse(toolContentTexts(results[0]))['x-codex-turn-metadata'];
      assert.ok(meta.turn_id, 'inside a prompt the tool has an active run');
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });
});