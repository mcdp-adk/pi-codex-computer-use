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
import { readCodexConfig } from '../src/config.mjs';
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
      config += `[mcp_servers.node_repl]\ncommand = '${command}'\n`;
      config += `[mcp_servers.node_repl.env]\n`;
      config += `NODE_REPL_TRUSTED_SERVICES = '{"sky":"@oai/sky/service"}'\n`;
      config += `NODE_REPL_NODE_MODULE_DIRS = '${nm}'\n`;
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
      config += `\n[marketplace]\nsource = '${mkt}'\n`;
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

  it('incomplete install through a package session: tools are hidden and one ui notice names every missing piece', async () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fakeCodexHome('empty');
    const cwd = makeTempRoot('pi-cua-test-3-hidden');
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: '42' }, text: 'trying the tool' },
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('try computer use');
        const toolNames = session.getActiveToolNames();
        assert.ok(!toolNames.includes('computer_use'), 'computer_use must be hidden when the install is incomplete');
        assert.ok(!toolNames.includes('computer_use_reset'), 'computer_use_reset must be hidden too');

        // The model asked anyway: the surfaced result explains, it does not run.
        const results = toolResults(session);
        assert.ok(results.length >= 1, 'one tool result expected');
        const text = toolContentTexts(results[0]);
        assert.match(text, /not found|not available|unknown|unavailable|invalid|hidden|refused|no active agent run|failed/i, 'the hidden tool surfaces an explanation');

        // One notice named the missing pieces (fix 12: observed via the
        // injected ui surface, not a globalThis backdoor).
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

  it('valid home through a package session: computer_use runs against the real runtime and carries turn metadata', async () => {
    const cwdHome = fakeCodexHome('valid', { replEntry: true, marketplace: true, skyRef: true });
    const prev = process.env.CODEX_HOME;
    // The fake home satisfies discovery (all three docs + a config entry) but
    // names no runnable REPL. The runtime stays the real one: point the fake
    // config entry at the real node_repl command from the REAL user config.
    const real = readCodexConfig();
    if (real.missing?.length) this.skip();
    const cfgToml = fs.readFileSync(path.join(cwdHome, 'config.toml'), 'utf8');
    fs.writeFileSync(path.join(cwdHome, 'config.toml'), cfgToml.replace(
      /command = '.*'/,
      `command = '${String(real.command).replace(/'/g, String.fromCharCode(92) + String.fromCharCode(39))}'`,
    ));
    process.env.CODEX_HOME = cwdHome;
    const cwd = makeTempRoot('pi-cua-test-3-ok');
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: "nodeRepl.write(JSON.stringify(nodeRepl.requestMeta ?? 'NO_META'));" } },
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('run a cell');
        const toolNames = session.getActiveToolNames();
        assert.ok(toolNames.includes('computer_use'), 'computer_use visible when the install is complete');

        const results = toolResults(session);
        assert.ok(!results[0]?.isError, `cell failed: ${toolContentTexts(results[0])}`);
        const text = toolContentTexts(results[0]);
        // The runtime may echo non-JSON lines before the cell's write; take
        // the last line that looks like the meta object.
        const jsonLine = text.split('\n').filter((l) => l.trim().startsWith('{')).pop();
        const meta = jsonLine ? JSON.parse(jsonLine)['x-codex-turn-metadata'] : undefined;
        console.log('[dbg] text lines:', JSON.stringify(text));
        assert.ok(meta, `cell carried no turn metadata: ${text.slice(0, 200)}`);
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
