// Acceptance tests for issue #3: hide the computer-use tools when the Codex
// installation is incomplete. The Codex installation itself (CODEX_HOME) may
// be faked with a doctored directory — that IS "the installation is
// incomplete" — but the REPL behind the complete install stays real.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readCodexConfig } from '../src/config.mjs';
import { discover, codexHome } from '../src/discovery.mjs';
import { makeTempRoot } from './harness.js';

// Build a doctored CODEX_HOME in a temp dir. `parts` toggles which pieces of
// a valid installation are present; anything not toggled is missing.
function fakeCodexHome(label, parts = {}) {
  const home = path.join(os.tmpdir(), `codex-home-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(home, { recursive: true });
  const command = path.join(home, 'bin', 'node_repl.exe');
  let config = '';
  if (parts.config !== false) {
    if (parts.replEntry) {
      if (parts.commandFile !== false) fs.mkdirSync(path.dirname(command), { recursive: true });
      if (parts.commandFile !== false) fs.writeFileSync(command, '');
      config += '[mcp_servers.node_repl]\ncommand = "' + command.replace(/\\/g, '\\\\') + '"\n';
    }
    if (parts.marketplace) {
      const mkt = path.join(home, 'mkt');
      const docs = path.join(mkt, 'plugins', 'computer-use', 'docs');
      fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, 'guidance.md'), 'guide');
      fs.writeFileSync(path.join(docs, 'confirmations.md'), 'conf');
      config += '\n[marketplace]\nsource = "' + mkt.replace(/\\/g, '\\\\') + '"\n';
    }
    fs.writeFileSync(path.join(home, 'config.toml'), config);
  }
  if (parts.skyRef) {
    const nm = path.join(home, 'node_modules', '@oai', 'sky', 'docs');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'sky-window2-api.md'), 'api');
  }
  return home;
}

describe('issue #3 acceptance: hide the tools when the Codex installation is incomplete', () => {
  it('criterion 1: discovers a complete installation with all three docs', () => {
    // The real (complete) install on this machine must resolve cleanly; this
    // anchors the discovery rule against the real Codex config.
    const found = discover();
    assert.ok(found.ok, `real install should be complete; missing: ${found.missing?.join('; ')}`);
    assert.ok(found.repl?.command, 'repl command resolved');
    assert.equal(path.basename(found.docs.skyReference), 'sky-window2-api.md');
    assert.equal(path.basename(found.docs.guidance), 'guidance.md');
    assert.equal(path.basename(found.docs.confirmationPolicy), 'confirmations.md');
  });

  it('criterion 2: a missing piece makes discovery incomplete and names it', () => {
    const missingHome = fakeCodexHome('empty' /* nothing present */);
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = missingHome;
    try {
      const found = discover();
      assert.equal(found.ok, false, 'empty install must be incomplete');
      assert.ok(found.missing.length > 0, 'must name what is missing');
      assert.ok(
        found.missing.some((m) => /config/i.test(m)),
        `missing list should name the config, got: ${found.missing.join('; ')}`,
      );
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('criterion 3: incomplete => one notice naming every missing piece', async () => {
    // Drive the full pi session with a doctored CODEX_HOME so discovery fails,
    // and assert the extension strips its tools + emits ONE notice naming the gap.
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fakeCodexHome('empty');
    try {
      const { pathToFileURL: toUrl } = await import('node:url');
      const extUrl = toUrl(path.resolve(import.meta.dirname, '..', 'src', 'extension.mjs'));
      // Fresh module instance so module state (noticed flag) is reset.
      const mod = await import(extUrl.href + '?missing=' + Date.now());
      const pi = makePiStub();
      const ret = mod.default(pi);
      assert.ok(pi.registered.includes('list_apps'), 'tools register so they are visible when complete');
      assert.ok(pi.registered.includes('take_screenshot'));

      // Simulate session_start with an AgentSession that can hide tools.
      const session = {
        names: ['read', 'bash', 'edit', 'write', 'list_apps', 'take_screenshot'],
        getActiveToolNames() { return [...this.names]; },
        setActiveToolsByName(arr) { this.names = [...arr]; },
      };
      mod._setActiveSessionForTests(session);
      pi.fire('session_start', {}, { ui: { notify: (msg, kind) => pi.notices.push({ msg, kind }) } });

      assert.deepEqual(sortBy(session.names), ['bash', 'edit', 'read', 'write'], 'computer-use tools must be hidden when incomplete');
      assert.equal(pi.notices.length, 1, 'exactly ONE notice');
      const notice = pi.notices[0].msg;
      assert.ok(/incomplete/i.test(notice), 'notice names the installation as incomplete');
      assert.ok(/codex/i.test(notice), 'notice names Codex');

      // Firing again must NOT emit a second notice.
      pi.fire('session_start', {}, { ui: { notify: (m, k) => pi.notices.push({ msg: m, kind: k }) } });
      assert.equal(pi.notices.length, 1, 'still exactly one notice');
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('criterion 4: complete => tools stay registered, no notice', async () => {
    const { pathToFileURL: toUrl } = await import('node:url');
    const extUrl = toUrl(path.resolve(import.meta.dirname, '..', 'src', 'extension.mjs'));
    const mod = await import(extUrl.href + '?complete=' + Date.now());
    const pi = makePiStub();
    const ret = mod.default(pi);

    const session = {
      names: ['read', 'bash', 'edit', 'write', 'list_apps', 'take_screenshot'],
      getActiveToolNames() { return [...this.names]; },
      setActiveToolsByName(arr) { this.names = [...arr]; },
    };
    mod._setActiveSessionForTests(session);
    pi.fire('session_start', {}, { ui: { notify: (m, k) => pi.notices.push({ msg: m, kind: k }) } });

    assert.ok(session.names.includes('list_apps'), 'list_apps stays active when complete');
    assert.ok(session.names.includes('take_screenshot'), 'take_screenshot stays active when complete');
    assert.equal(pi.notices.length, 0, 'no notice when complete');
  });
});

function makePiStub() {
  return {
    registered: [],
    notices: [],
    handlers: {},
    registerTool(t) { this.registered.push(t.name); },
    on(event, handler) { this.handlers[event] = handler; },
    fire(event, args, ctx) { this.handlers[event]?.(args ?? {}, ctx ?? {}); },
  };
}

function sortBy(a) {
  return [...a].sort();
}
