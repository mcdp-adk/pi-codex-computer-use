// Tests for the per-agent-run turn metadata each cell carries. The physical
// Escape press itself is owner-manual. Seam: real pi SDK session with a faux
// provider scripting tool calls; the REPL is the real runtime. Assert only
// what the user/model observes: the cell returns the request meta it saw
// (nodeRepl.requestMeta), turn ids change between agent runs, and pi's
// session id is carried as session_id.
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { makeTempRoot, withRealRuntime, createScriptedSession, toolResults, toolContentTexts, isRecord } from './harness.ts';

withRealRuntime('turn metadata on every computer-use cell (observed by the cell)', () => {
  // One directory for the whole suite, removed with every other test
  // directory when the test process exits (test/harness.ts).
  const root = makeTempRoot('pi-cua-t5');

  // The cell writes what the runtime handed it as request meta. If no meta
  // arrived, write a marker so the assertion fails loudly rather than on
  // undefined parsing.
  const META_PROBE_CELL =
    "nodeRepl.write(typeof nodeRepl.requestMeta === 'undefined' ? 'NO_REQUEST_META' : JSON.stringify(nodeRepl.requestMeta));";

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
      const meta: unknown = JSON.parse(text);
      assert.ok(isRecord(meta) && meta['x-codex-turn-metadata'], `turn metadata key missing in ${text}`);
      const turnMeta: unknown = meta['x-codex-turn-metadata'];
      const sessionId: unknown = isRecord(turnMeta) ? turnMeta['session_id'] : undefined;
      const turnId: unknown = isRecord(turnMeta) ? turnMeta['turn_id'] : undefined;
      assert.equal(sessionId, session.sessionManager.getSessionId(), 'session_id is pi session id');
      assert.ok(turnId, 'turn_id present');
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
      const firstBody: unknown = JSON.parse(toolContentTexts(results[0]));
      const secondBody: unknown = JSON.parse(toolContentTexts(results[1]));
      const first: unknown = isRecord(firstBody) ? firstBody['x-codex-turn-metadata'] : undefined;
      const second: unknown = isRecord(secondBody) ? secondBody['x-codex-turn-metadata'] : undefined;
      const piSessionId = session.sessionManager.getSessionId();
      const firstSessionId: unknown = isRecord(first) ? first['session_id'] : undefined;
      const secondSessionId: unknown = isRecord(second) ? second['session_id'] : undefined;
      assert.equal(firstSessionId, piSessionId);
      assert.equal(secondSessionId, piSessionId);
      const firstTurnId: unknown = isRecord(first) ? first['turn_id'] : undefined;
      const secondTurnId: unknown = isRecord(second) ? second['turn_id'] : undefined;
      assert.notEqual(secondTurnId, firstTurnId, 'turn_id must change between agent runs');
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });
});
