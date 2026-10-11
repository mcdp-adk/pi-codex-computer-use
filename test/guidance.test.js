// Tests for issue #4: the computer_use description routes the model to the
// skill + the three discovered Codex documents, and the extension exposes a
// `computer_use_tool_paths` tool reporting their on-disk locations.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { discover } from '../src/discovery.mjs';

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

describe('issue #4: guide the model with the skill and Codex guidance', () => {
  let mod, pi;
  before(async () => {
    mod = await import(extUrl().href + '?t4=' + Date.now());
    pi = makePiStub();
    mod.default(pi);
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
  });

  it('a computer_use_tool_paths tool reports the located documents and the skills directory', async () => {
    const tool = pi.tools.computer_use_tool_paths;
    assert.ok(tool, 'computer_use_tool_paths must be registered');
    const res = await tool.execute();
    assert.ok(!res.isError, 'paths tool should not error on this install: ' + res.content.map(c=>c.text).join('\n'));
    const report = JSON.parse(res.content[0].text);

    // Located documents exist on disk and point at the right Codex files.
    assert.ok(fs.existsSync(report.computer_use_guidance_path), 'guidance exists: ' + report.computer_use_guidance_path);
    assert.ok(fs.existsSync(report.computer_use_confirmations_path), 'confirmations exists: ' + report.computer_use_confirmations_path);
    assert.ok(fs.existsSync(report.computer_use_sky_api_path), 'sky reference exists: ' + report.computer_use_sky_api_path);
    assert.match(report.computer_use_guidance_path, /guidance\.md$/);
    assert.match(report.computer_use_confirmations_path, /confirmations\.md$/);
    assert.match(report.computer_use_sky_api_path, /sky-window2-api\.md$/);

    // The skills directory the extension ships, and the guidance skill in it.
    assert.ok(fs.existsSync(path.join(report.computer_use_skills_dir, 'codex-computer-use', 'SKILL.md')), 'codex-computer-use skill exists under the reported skills dir');
    assert.equal(report.computer_use_skill, 'codex-computer-use');
  });

  it('the reported paths agree with discovery.mjs', async () => {
    const tool = pi.tools.computer_use_tool_paths;
    const res = await tool.execute();
    const report = JSON.parse(res.content[0].text);
    const found = discover();
    assert.equal(found.ok, true, 'real install discovered');
    assert.equal(report.computer_use_guidance_path, found.docs.guidance);
    assert.equal(report.computer_use_confirmations_path, found.docs.confirmationPolicy);
    assert.equal(report.computer_use_sky_api_path, found.docs.skyReference);
  });

  it('the skill file has correct Agent-Skills frontmatter and names the three documents', () => {
    const skillPath = path.resolve(import.meta.dirname, '..', 'skills', 'codex-computer-use', 'SKILL.md');
    const text = fs.readFileSync(skillPath, 'utf8');
    assert.match(text, /^---\nname: codex-computer-use\n/m, 'frontmatter name');
    assert.match(text, /description: .+/m, 'frontmatter description');
    for (const name of ['guidance.md', 'confirmations.md', 'sky-window2-api.md']) {
      assert.ok(text.includes(name), `skill names ${name}`);
    }
    assert.match(text, /globalThis/, 'skill tells the model state lives on globalThis');
    assert.match(text, /nodeRepl\.write/, 'skill tells the model to write results via nodeRepl.write');
  });
});
