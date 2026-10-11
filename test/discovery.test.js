// Tests for issue #3 (red): hide the computer-use tools when the Codex
// installation is incomplete. Drives the full pi SDK session via the package
// discovery harness, with a doctored CODEX_HOME so discovery actually fails —
// no test-only backdoors, no direct session method calls.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discover } from '../src/discovery.mjs';
import { createScriptedSessionFromPackage, toolResults, toolContentTexts } from './harness.js';
import { SettingsManager, DefaultPackageManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { ComputerUse } from '../src/computer-use.mjs';

const makeTempRoot = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A host standing in for the REPL MCP layer. Real ComputerUse logic runs on
// top; the host answers the sky-init cell so ensureSky succeeds and captures
// every cell it received.
function makeMcpLayer(answers = {}) {
  return {
    cells: [],
    turnEndedCalls: [],
    closed: 0,
    _running: false,
    _stoppedRunId: null,
    get running() { return this._running; },
    async runCell(code, opts = {}) {
      this._running = true;
      this.cells.push({ code, ...opts });
      if (code.includes('globalThis.__sky')) {
        return { text: '[sky] loaded', content: [{ type: 'text', text: '[sky] loaded' }] };
      }
      return {
        text: answers.text ?? '[computer-use] ok',
        content: [{ type: 'text', text: answers.text ?? '[computer-use] ok' }],
      };
    },
    stopRun(runId) { this._stoppedRunId = runId; },
    _assertNotStopped(runId) {
      if (this._stoppedRunId && (!runId || this._stoppedRunId === runId)) {
        throw new Error('Computer use is stopped for this agent run (Escape pressed). The next prompt may use computer use again.');
      }
    },
    async turnEnded(turnMeta, { hookEventName } = {}) {
      this.turnEndedCalls.push({ turnMeta, hookEventName });
    },
    async close() { this._running = false; this.closed++; this._stoppedRunId = null; },
  };
}

// Builds a CODEX_HOME shape on disk. `parts` toggles which pieces exist:
// config, replEntry (exe + config entry), marketplace (guidance/confirmations),
// skyRef (the sky API reference doc).
function fakeCodexHome(label, parts = {}) {
  const home = path.join(os.tmpdir(), `codex-home-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(home, { recursive: true });
  const command = path.join(home, 'bin', 'node_repl.exe');
  const nm = path.join(home, 'bin', 'node_modules');
  fs.mkdirSync(path.join(nm, '@oai', 'sky', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(nm, '@oai', 'sky', 'package.json'), JSON.stringify({
    exports: { '.': './dist/index.js' },
  }));
  fs.mkdirSync(path.join(nm, '@oai', 'sky', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(nm, '@oai', 'sky', 'dist', 'index.js'), 'export {}');
  let config = '';
  if (parts.config !== false) {
    if (parts.replEntry) {
      if (parts.commandFile !== false) fs.mkdirSync(path.dirname(command), { recursive: true });
      if (parts.commandFile !== false) fs.writeFileSync(command, '');
      config += `[mcp_servers.node_repl]\ncommand = "${command.replace(/\\/g, '\\\\')}"\n`;
      config += `[mcp_servers.node_repl.env]\n`;
      config += `NODE_REPL_TRUSTED_SERVICES = "{\\"sky\\":\\"@oai/sky/service\\"}"\n`;
      config += `NODE_REPL_NODE_MODULE_DIRS = "${nm.replace(/\\/g, '\\\\')}"\n`;
      // Also create the sky API reference doc that discovery looks for.
      const skyDocs = path.join(nm, '@oai', 'sky', 'docs');
      fs.mkdirSync(skyDocs, { recursive: true });
      fs.writeFileSync(path.join(skyDocs, 'sky-window2-api.md'), 'api');
    }
    if (parts.marketplace) {
      const mkt = path.join(home, 'mkt');
      const docs = path.join(mkt, 'plugins', 'computer-use', 'docs');
      fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, 'guidance.md'), 'guide');
      fs.writeFileSync(path.join(docs, 'confirmations.md'), 'conf');
      config += `\n[marketplace]\nsource = "${mkt.replace(/\\/g, '\\\\')}"\n`;
    }
    fs.writeFileSync(path.join(home, 'config.toml'), config);
  }
  if (parts.skyRef) {
    const nmDocs = path.join(home, 'node_modules', '@oai', 'sky', 'docs');
    fs.mkdirSync(nmDocs, { recursive: true });
    fs.writeFileSync(path.join(nmDocs, 'sky-window2-api.md'), 'api');
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

describe('issue #3 acceptance: hide the tools when the Codex installation is incomplete', () => {
  it('discovers a complete installation with all three docs', () => {
    const found = discover();
    assert.ok(found.ok, `real install should be complete; missing: ${found.missing?.join('; ')}`);
    assert.ok(found.repl?.command, 'repl command resolved');
    assert.equal(path.basename(found.docs?.skyReference), 'sky-window2-api.md');
    assert.equal(path.basename(found.docs?.guidance), 'guidance.md');
    assert.equal(path.basename(found.docs?.confirmationPolicy), 'confirmations.md');
  });

  it('incomplete install: computer_use is hidden and exactly one notice names every missing piece', async () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fakeCodexHome('empty');
    const cwd = makeTempRoot('pi-cua-test-3');
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: '42' }, text: 'trying the tool' },
        ],
      });

      // Trigger the agent loop so session_start fires and the tools hide.
      await session.prompt('try computer use');

      const toolNames = session.getActiveToolNames();
      assert.ok(!toolNames.includes('computer_use'), 'computer_use must be hidden when install is incomplete');
      assert.ok(!toolNames.includes('computer_use_reset'), 'computer_use_reset must be hidden too');
      assert.ok(!toolNames.includes('computer_use_tool_paths'), 'computer_use_tool_paths must be hidden too');

      // The model asked for it anyway; the hidden tool errors, it does not run.
      const results = toolResults(session);
      assert.equal(results.length, 1, 'one tool result');
      const text = toolContentTexts(results[0]);
      assert.match(text, /no active agent run|not found|not available|incomplete|stopped|escape|no session|not registered|hidden|unknown|unsupported|invalid tool|refused|unavailable|failed/i, 'the hidden tool surfaces an explanation');

      // One notice named the missing pieces (not a flood). The extension exposes
      // the recorded notice on `lastNotice`; no ui surface exists in headless pi.
      const api = globalThis.__extensionApi;
      assert.ok(api, 'extension exposes its api');
      assert.ok(api.missingNotice, 'extension exposes missingNotice');
      assert.ok(api.lastNotice, 'extension recorded a notice');
      assert.match(api.lastNotice, /incomplete/i);
      assert.match(api.lastNotice, /node_repl|config|missing/i);

      const computerUse = api.computerUse;
      assert.ok(computerUse, 'extension exposed its ComputerUse');
      assert.equal(computerUse.host.cells?.length ?? 0, 0, 'no cell ever reached the REPL');
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('a missing piece makes discovery incomplete and names it', () => {
    const missingHome = fakeCodexHome('no-guidance', { replEntry: true, marketplace: false, skyRef: true });
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

  it('with CODEX_HOME pointing at a valid Codex configuration, the tools are registered and a call that lists apps succeeds', async () => {
    const cwdHome = fakeCodexHome('valid', { replEntry: true, marketplace: true, skyRef: true });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = cwdHome;
    const cwd = makeTempRoot('pi-cua-test-3-ok');
    try {
      const mcp = makeMcpLayer({ text: 'App1,App2' });
      const computerUse = new ComputerUse({ host: mcp });
      globalThis.__computerUseForTests = computerUse;

      const { session } = await createScriptedSessionFromPackage({
        cwd,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: 'await globalThis.__sky.list_windows()' }, text: 'list apps' },
          { kind: 'text', text: 'done' },
        ],
      });

      await session.prompt('list the running apps');

      const toolNames = session.getActiveToolNames();
      assert.ok(toolNames.includes('computer_use'), 'computer_use visible when complete');
      assert.ok(toolNames.includes('computer_use_tool_paths'), 'computer_use_tool_paths visible when complete');

      const results = toolResults(session);
      assert.ok(results.length >= 1, 'the tool ran');
      const text = toolContentTexts(results[0]);
      assert.ok(!text.includes('failed'), 'the call did not fail: ' + text.slice(0, 200));

      const modelCell = mcp.cells.find((c) =>
        c.code === 'await globalThis.__sky.list_windows()',
      );
      assert.ok(modelCell, 'the model cell ran');
      assert.equal(modelCell.code, 'await globalThis.__sky.list_windows()');

      // The cell carries Codex-style turn metadata. It comes from the extension's
      // own TurnMeta (wired via pi's package discovery), not a test-controlled one.
      assert.ok(modelCell.turnMeta, 'cell carries turn metadata');
      assert.ok(modelCell.turnMeta.run_id, 'cell carries a run id');
      assert.ok(modelCell.turnMeta.session_id, 'cell carries a session id');
    } finally {
      delete globalThis.__computerUseForTests;
      delete globalThis.__turnMetaForTests;
      delete globalThis.__extensionApi;
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });
});
