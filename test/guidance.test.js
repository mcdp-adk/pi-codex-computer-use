// Tests for the computer_use description: it routes the model to the skill
// and the three discovered Codex documents, and the shipped skill file tells
// the model to read them. Observed through a real pi session that loads the
// package the way pi does — no direct extension invocation, no discovery
// call. Needs a real Codex installation to discover and skips visibly
// without one, like every runtime-gated suite.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  makeTempRoot,
  createScriptedSession,
  withRealRuntime,
  toolResults,
  toolContentTexts,
} from './harness.js';

// The description is built at factory time from what discovery found: without
// a real installation there are no tool registrations and no discovered
// documents to assert on.
let session, toolsSnapshot;

withRealRuntime('guide the model with the skill and Codex guidance', () => {
  // One directory for the whole suite, removed with every other test
  // directory when the test process exits (test/harness.js).
  const root = makeTempRoot('pi-cua-t4');
  const sessionPromise = createScriptedSession({
    cwd: root,
    scripts: [
      // The model reads the computer_use description, runs one probe cell to
      // prove the registration is live, then settles.
      { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write('guided ok');" } },
      { kind: 'text', text: 'done' },
    ],
  });

  before(async () => {
    // createScriptedSession answers { session, loader } — destructure it.
    session = (await sessionPromise).session;
    await session.prompt('load the package and probe computer use');
    toolsSnapshot = session.getAllTools().map((t) => ({ name: t.name, description: t.description }));
    const results = toolResults(session);
    assert.ok(results.length === 1 && !results[0].isError, `probe cell failed: ${toolContentTexts(results[0])}`);
  });

  after(async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  });

  it('only computer_use and computer_use_reset are registered', () => {
    const names = toolsSnapshot.filter((t) => t.name.startsWith('computer_use')).map((t) => t.name).sort();
    assert.deepEqual(names, ['computer_use', 'computer_use_reset']);
  });

  it('the computer_use description names the skill and the three located documents', () => {
    const d = toolsSnapshot.find((t) => t.name === 'computer_use').description;
    assert.match(d, /codex-computer-use/, 'description must tell the model to load the skill');
    assert.match(d, /computer_use_guidance_path/, 'description must name the guidance document');
    assert.match(d, /computer_use_confirmations_path/, 'description must name the confirmation policy');
    assert.match(d, /computer_use_sky_api_path/, 'description must name the sky API reference');
    // and it gives the REPL's semantics in passing
    assert.match(d, /globalThis/, 'description notes state lives on globalThis');
    assert.match(d, /nodeRepl\.write/, 'description notes text returns via nodeRepl.write');
    // The named paths agree with the real installation (checked in the next
    // test, which resolves and opens them on disk).
    for (const name of ['guidance.md', 'confirmations.md', 'sky-window2-api.md']) {
      assert.ok(d.includes(name), `description names ${name}`);
    }
  });

  it('the named guidance paths exist on the real installation', () => {
    const d = toolsSnapshot.find((t) => t.name === 'computer_use').description;
    const paths = d.match(/[A-Za-z]:\\[^`\s]+/g) ?? [];
    assert.ok(paths.length >= 3, `description names no discoverable paths: ${d.slice(-400)}`);
    for (const p of paths) {
      assert.ok(fs.existsSync(p), `named path ${p} exists`);
    }
  });

  it('the skill file has correct Agent-Skills frontmatter and names the three documents', () => {
    const skillPath = path.resolve(import.meta.dirname, '..', 'skills', 'codex-computer-use', 'SKILL.md');
    const text = fs.readFileSync(skillPath, 'utf8');
    assert.match(text, /^---\nname: codex-computer-use\n/m, 'frontmatter name');
    assert.match(text, /description: .+/m, 'frontmatter description');
    for (const name of ['guidance.md', 'confirmations.md', 'sky-window2-api.md']) {
      assert.ok(text.includes(name), `skill names ${name}`);
    }
    assert.doesNotMatch(text, /computer_use_tool_paths/, 'the removed tool_paths tool is gone from the skill');
  });
});