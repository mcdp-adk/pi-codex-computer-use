// Tests for the per-agent-run turn metadata each cell carries. The physical
// Escape press itself is owner-manual. Seam: real pi SDK session with a faux
// provider scripting tool calls; the REPL is the real runtime. Assert only
// what the user/model observes: the cell returns the request meta it saw
// (nodeRepl.requestMeta), turn ids change between agent runs, and pi's
// session id is carried as session_id.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeTempRoot, withRealRuntime, createScriptedSession, toolResults, toolContentTexts } from './harness.js';

withRealRuntime('turn metadata on every computer-use cell (observed by the cell)', () => {
  // One directory for the whole suite, removed with every other test
  // directory when the test process exits (test/harness.js).
  const root = makeTempRoot('pi-cua-t5');
  fs.mkdirSync(root, { recursive: true });

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
});