// Tests for the computer_use description: it routes the model to the skill
// and the three discovered Codex documents, and the shipped skill file tells
// the model to read them.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { discover } from '../src/discovery.mjs';
import { readCodexConfig } from '../src/config.mjs';

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

const hasRealRuntime = () => {
  try {
    const cfg = readCodexConfig();
    return !cfg.missing?.length && fs.existsSync(cfg.command);
  } catch {
    return false;
  }
};

// The description is built at factory time from what discovery found: without
// a real installation there are no tool registrations and no discovered
// documents to assert on. Skips visibly, like the runtime-gated suites.
const withRuntime = hasRealRuntime() ? describe : describe.skip;

withRuntime('guide the model with the skill and Codex guidance', () => {
  let mod, pi;
  before(async () => {
    mod = await import(extUrl().href + '?t4=' + Date.now());
    pi = makePiStub();
    mod.default(pi);
  });

  it('only computer_use and computer_use_reset are registered', () => {
    const names = Object.keys(pi.tools).sort();
    assert.deepEqual(names, ['computer_use', 'computer_use_reset']);
  });

  it('the computer_use description names the skill and the three located documents', () => {
    const d = pi.tools.computer_use.description;
    assert.match(d, /codex-computer-use/, 'description must tell the model to load the skill');
    assert.match(d, /computer_use_guidance_path/, 'description must name the guidance document');
    assert.match(d, /computer_use_confirmations_path/, 'description must name the confirmation policy');
    assert.match(d, /computer_use_sky_api_path/, 'description must name the sky API reference');
    // and it gives the REPL's semantics in passing
    assert.match(d, /globalThis/, 'description notes state lives on globalThis');
    assert.match(d, /nodeRepl\.write/, 'description notes text returns via nodeRepl.write');
    // The named paths agree with discovery on this install.
    const found = discover();
    assert.equal(found.ok, true, 'real install discovered; missing: ' + (found.missing ?? []).join('; '));
    for (const p of [found.docs.guidance, found.docs.confirmationPolicy, found.docs.skyReference]) {
      assert.ok(d.includes(p), `description names the discovered path ${p}`);
      assert.ok(fs.existsSync(p), `${p} exists`);
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