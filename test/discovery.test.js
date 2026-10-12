// Tests for the completeness discovery and skill shipping. Drives the full
// pi SDK session via the package discovery harness, with a doctored
// CODEX_HOME so discovery actually fails — no test-only backdoors, no direct
// session method calls.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discover } from '../src/discovery.mjs';
import { readCodexConfig } from '../src/config.mjs';
import { createScriptedSessionFromPackage, makeTempRoot, toolResults, toolContentTexts } from './harness.js';
import { SettingsManager, DefaultPackageManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

// Builds a CODEX_HOME shape on disk. `parts` toggles which pieces exist:
// config, replEntry (exe + config entry + sky package + sky API ref doc),
// marketplace (guidance/confirmations), skyPkg (the @oai/sky package under
// the node_modules the REPL env names), skyEntry (the package's export
// entry file; off leaves a bare manifest, like a half-copied install).
// The process-exit hook in test/harness.js removes the directory; every test
// creates its directories only through makeTempRoot.
function fakeCodexHome(label, parts = {}) {
  const home = makeTempRoot(`codex-home-${label}`);
  const command = path.join(home, 'bin', 'node_repl.exe');
  const nm = path.join(home, 'bin', 'node_modules');
  let config = '';
  if (parts.config !== false) {
    if (parts.replEntry) {
      if (parts.commandFile !== false) fs.mkdirSync(path.dirname(command), { recursive: true });
      if (parts.commandFile !== false) fs.writeFileSync(command, '');
      config += `[mcp_servers.node_repl]\ncommand = '${command}'\n`;
      config += `[mcp_servers.node_repl.env]\n`;
      config += `NODE_REPL_TRUSTED_SERVICES = '${JSON.stringify({ sky: '@oai/sky/service' }).replace(/'/g, "\\'")}'\n`;
      config += `NODE_REPL_NODE_MODULE_DIRS = '${nm}'\n`;
      if (parts.skyPkg !== false) {
        fs.mkdirSync(path.join(nm, '@oai', 'sky', 'docs'), { recursive: true });
        fs.writeFileSync(path.join(nm, '@oai', 'sky', 'package.json'), JSON.stringify({
          exports: { '.': './dist/index.js' },
        }));
        if (parts.skyEntry !== false) {
          fs.mkdirSync(path.join(nm, '@oai', 'sky', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(nm, '@oai', 'sky', 'dist', 'index.js'), 'export {}');
        }
        // Also create the sky API reference doc that discovery looks for.
        fs.writeFileSync(path.join(nm, '@oai', 'sky', 'docs', 'sky-window2-api.md'), 'api');
      }
    }
    if (parts.marketplace) {
      const mkt = path.join(home, 'mkt');
      const docs = path.join(mkt, 'plugins', 'computer-use', 'docs');
      fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, 'guidance.md'), 'guide');
      fs.writeFileSync(path.join(docs, 'confirmations.md'), 'conf');
      config += `\n[marketplace]\nsource = '${mkt}'\n`;
    }
    fs.writeFileSync(path.join(home, 'config.toml'), config);
  }
  return home;
}

describe('skill registration: the pi manifest ships the codex-computer-use skill', () => {
  it('the package pi manifest declares the skill directory', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
    assert.ok(Array.isArray(manifest.pi?.skills), 'pi manifest must declare skills: [...]');
    assert.ok(manifest.pi.skills.length >= 1, 'at least one skill entry');
    for (const entry of manifest.pi.skills) {
      const p = path.resolve(import.meta.dirname, '..', entry, 'SKILL.md');
      assert.ok(fs.existsSync(p), `skill entry ${entry} has a SKILL.md`);
    }
  });

  it('discovery: pi packagemanager/resourceLoader discover the skill', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const settingsManager = SettingsManager.inMemory({ packages: [repoRoot] });
    const packageManager = new DefaultPackageManager({ cwd: repoRoot, agentDir: repoRoot, settingsManager, builtinExtensions: [] });
    const loader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir: repoRoot,
      settingsManager,
      packageManager,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { skills } = loader.getSkills();
    const skill = skills.find((s) => s.name === 'codex-computer-use');
    assert.ok(skill, `codex-computer-use not discovered; got: ${skills.map((s) => s.name).join(', ')}`);
    assert.ok(fs.existsSync(skill.filePath), 'skill filePath exists');
    // The session path (harness package loader) sees the same skills.
    const cwd = makeTempRoot('pi-cua-skill');
    const pkg = await createScriptedSessionFromPackage({ cwd, scripts: [] });
    try {
      const names = pkg.loader.getSkills().skills.map((s) => s.name);
      assert.ok(names.includes('codex-computer-use'), `skill not offered through the package session path: ${names.join(', ')}`);
    } finally {
      pkg.session.dispose();
    }
  });
});
describe('completeness discovery: tools only exist when the Codex installation is complete', () => {
  // Needs a real installation to discover; skips visibly without one (e.g. on
  // a CI runner), like the runtime-gated suites elsewhere in this directory.
  const withRealInstall = (() => {
    try {
      const cfg = readCodexConfig();
      return !cfg.missing?.length && fs.existsSync(cfg.command) ? describe : describe.skip;
    } catch {
      return describe.skip;
    }
  })();

  withRealInstall('discovers a complete installation with all three docs', () => {
    it('discovers a complete installation with all three docs', () => {
      const found = discover();
      assert.ok(found.ok, `real install should be complete; missing: ${found.missing?.join('; ')}`);
      assert.ok(found.repl?.command, 'repl command resolved');
      assert.equal(path.basename(found.docs?.skyReference), 'sky-window2-api.md');
      assert.equal(path.basename(found.docs?.guidance), 'guidance.md');
      assert.equal(path.basename(found.docs?.confirmationPolicy), 'confirmations.md');
    });
  });

  it('a missing piece makes discovery incomplete and names it', () => {
    const missingHome = fakeCodexHome('no-guidance', { replEntry: true, marketplace: false });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = missingHome;
    try {
      const found = discover();
      assert.equal(found.ok, false, 'install without the guidance is incomplete');
      assert.ok(found.missing.length > 0, 'must name what is missing');
      assert.ok(
        found.missing.some((m) => /guidance/i.test(m)),
        `missing list should name the guidance, got: ${found.missing.join('; ')}`,
      );
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('a bare manifest without the export entry makes discovery incomplete', () => {
    const missingHome = fakeCodexHome('no-sky-entry', { replEntry: true, marketplace: true, skyEntry: false });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = missingHome;
    try {
      const found = discover();
      assert.equal(found.ok, false, 'manifest without its export entry must be incomplete');
      assert.ok(
        found.missing.some((m) => /sky module|@oai\/sky/i.test(m)),
        `missing list should name the sky package, got: ${found.missing.join('; ')}`,
      );
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('incomplete install through a package session: no tools registered and one ui notice names every missing piece', async () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fakeCodexHome('empty');
    const cwd = makeTempRoot('pi-cua-incomplete');
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd,
        scripts: [
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('try computer use');
        // Full registry, not just active tools: an incomplete install must
        // not register the computer-use tools at all.
        const allNames = session.getAllTools().map((t) => t.name);
        assert.ok(!allNames.includes('computer_use'), 'computer_use must not be registered when the install is incomplete');
        assert.ok(!allNames.includes('computer_use_reset'), 'computer_use_reset must not be registered either');

        // One notice named the missing pieces, observed via the injected ui
        // surface.
        const notices = session.notifications.map((n) => n.message);
        assert.equal(notices.length, 1, `exactly one notice expected, got: ${JSON.stringify(notices)}`);
        assert.match(notices[0], /incomplete/i);
        assert.match(notices[0], /node_repl|config|missing/i);
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('missing guidance through a package session: no tools registered and one ui notice names the guidance', async () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fakeCodexHome('no-guidance', { replEntry: true, marketplace: false });
    const cwd = makeTempRoot('pi-cua-no-guidance');
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd,
        scripts: [
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('try computer use');
        // Full registry, not just active tools: a missing guidance must keep
        // the computer-use tools out of the registry entirely.
        const allNames = session.getAllTools().map((t) => t.name);
        assert.ok(!allNames.includes('computer_use'), 'computer_use must not be registered when the guidance is missing');
        assert.ok(!allNames.includes('computer_use_reset'), 'computer_use_reset must not be registered either');

        // One notice naming the missing guidance, observed via the injected
        // ui surface.
        const notices = session.notifications.map((n) => n.message);
        assert.equal(notices.length, 1, `exactly one notice expected, got: ${JSON.stringify(notices)}`);
        assert.match(notices[0], /guidance/i, `notice should name the guidance, got: ${notices[0]}`);
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('valid home through a package session: computer_use runs against the real runtime and carries turn metadata', async (t) => {
    // Skip visibly before building anything: this case needs a real runtime;
    // a silent return would look like a vacuous pass.
    const real = readCodexConfig();
    if (real.missing?.length || !real.command || !real.env?.NODE_REPL_NODE_MODULE_DIRS) {
      t.skip('needs a real Codex runtime to drive');
      return;
    }
    const cwdHome = fakeCodexHome('valid', { replEntry: true, marketplace: true });
    const prev = process.env.CODEX_HOME;
    const nm = String(real.env.NODE_REPL_NODE_MODULE_DIRS).replace(/'/g, String.fromCharCode(92) + String.fromCharCode(39));
    const command = String(real.command).replace(/'/g, String.fromCharCode(92) + String.fromCharCode(39));
    // The runtime resolves @oai/sky/service only from a trusted module
    // directory, which the real config names via NODE_REPL_TRUSTED_CODE_PATHS;
    // a migrated home carries the real env, so copy it too.
    const tcp = String(real.env.NODE_REPL_TRUSTED_CODE_PATHS).replace(/'/g, String.fromCharCode(92) + String.fromCharCode(39));
    const cfgToml = fs.readFileSync(path.join(cwdHome, 'config.toml'), 'utf8');
    fs.writeFileSync(path.join(cwdHome, 'config.toml'), cfgToml
      .replace(/command = '.*'/, `command = '${command}'`)
      .replace(/NODE_REPL_NODE_MODULE_DIRS = '.*'/, `NODE_REPL_NODE_MODULE_DIRS = '${nm}'\nNODE_REPL_TRUSTED_CODE_PATHS = '${tcp}'`));
    process.env.CODEX_HOME = cwdHome;
    const cwd = makeTempRoot('pi-cua-test-3-ok');
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: 'nodeRepl.write(JSON.stringify(await globalThis.sky.list_apps()).slice(0, 80));' } },
          { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write(JSON.stringify(nodeRepl.requestMeta ?? 'NO_META'));" } },
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('run a cell');
        const toolNames = session.getActiveToolNames();
        assert.ok(toolNames.includes('computer_use'), 'computer_use visible when the install is complete');

        const results = toolResults(session);
        assert.equal(results.length, 2, `expected 2 toolResults, got ${results.length}`);
        // Criterion 3: a call that lists apps succeeds against this home.
        assert.ok(!results[0]?.isError, `list-apps cell failed: ${toolContentTexts(results[0])}`);
        assert.match(
          toolContentTexts(results[0]),
          /id|title|displayName|app/i,
          `list-apps cell returned no app text: ${toolContentTexts(results[0]).slice(0, 200)}`,
        );
        const text = toolContentTexts(results[1]);
        // The runtime may echo non-JSON lines before the cell's write; take
        // the last line that looks like the meta object.
        const jsonLine = text.split('\n').filter((l) => l.trim().startsWith('{')).pop();
        const meta = jsonLine ? JSON.parse(jsonLine)['x-codex-turn-metadata'] : undefined;
        assert.ok(meta, `second cell carried no turn metadata: ${text.slice(0, 200)}`);
        assert.ok(meta.turn_id, 'cell carries a per-run turn id');
        assert.equal(meta.session_id, session.sessionManager.getSessionId(), 'session_id is pi session id');
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });
});
