// Tests for the Codex installation discovery, exercised only through a pi
// session: the discovery decides which tools the session registers and what
// its computer_use description names, so the sessions here assert exactly
// that. A fake Codex installation, a temporary directory named by CODEX_HOME
// and written by the test, sits behind the session seam: the test
// spells out Codex's file layout itself, not borrowing the package's
// constants. No test imports a module of the package.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  makeTempRoot,
  createScriptedSessionFromPackage,
  realCodexInstallation,
  withRealRuntime,
  toolResults,
  toolContentTexts,
  isRecord,
} from './harness.ts';
import { SettingsManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

// Builds a CODEX_HOME shape on disk. `parts` toggles which pieces exist:
// config, replEntry (exe + config entry + sky package + sky API ref doc),
// marketplace (guidance/confirmations), skyPkg (the @oai/sky package under
// the node_modules the REPL env names), skyEntry (the package's export
// entry file; off leaves a bare manifest, like a half-copied install),
// mainOnlyEntry (the manifest names its entry through both main and a
// bare-string exports pointing at different files, and only the file main
// names is on disk).
// The process-exit hook in test/harness.ts removes the directory; every test
// creates its directories only through makeTempRoot.
function fakeCodexHome(label: string, parts: {
  config?: boolean;
  replEntry?: boolean;
  commandFile?: boolean;
  skyPkg?: boolean;
  mainOnlyEntry?: boolean;
  skyEntry?: boolean;
  marketplace?: boolean;
} = {}): string {
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
        fs.mkdirSync(path.join(nm, '@oai', 'sky', 'dist'), { recursive: true });
        if (parts.mainOnlyEntry) {
          // The manifest itself names the entry twice, through main and through
          // a bare-string exports, pointing at different files — only the file
          // main names is on disk.
          fs.writeFileSync(path.join(nm, '@oai', 'sky', 'package.json'), JSON.stringify({
            main: './dist/main.js',
            exports: './dist/exports.js',
          }));
          fs.writeFileSync(path.join(nm, '@oai', 'sky', 'dist', 'main.js'), 'export {}');
        } else {
          fs.writeFileSync(path.join(nm, '@oai', 'sky', 'package.json'), JSON.stringify({
            exports: { '.': './dist/index.js' },
          }));
          if (parts.skyEntry !== false) {
            fs.writeFileSync(path.join(nm, '@oai', 'sky', 'dist', 'index.js'), 'export {}');
          }
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
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.ok(
      isRecord(manifest) && isRecord(manifest['pi']) && Array.isArray(manifest['pi']['skills']),
      'pi manifest must declare skills: [...]',
    );
    const skills: unknown[] = manifest['pi']['skills'];
    assert.ok(skills.length >= 1, 'at least one skill entry');
    for (const entry of skills) {
      assert.ok(
        typeof entry === 'string' && fs.existsSync(path.resolve(repoRoot, entry, 'SKILL.md')),
        `skill entry ${String(entry)} has a SKILL.md`,
      );
    }
  });

  it('discovery: pi packagemanager/resourceLoader discover the skill', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const settingsManager = SettingsManager.inMemory({ packages: [repoRoot] });
    const loader = new DefaultResourceLoader({
      cwd: repoRoot,
      agentDir: repoRoot,
      settingsManager,
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
  it('a bare manifest without the export entry makes discovery incomplete', async () => {
    const missingHome = fakeCodexHome('no-sky-entry', { replEntry: true, marketplace: true, skyEntry: false });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = missingHome;
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd: makeTempRoot('pi-cua-no-sky-entry'),
        scripts: [ { kind: 'text', text: 'done' } ],
      });
      try {
        await session.prompt('try computer use');
        const notices = session.notifications.map((n) => n.message);
        assert.equal(notices.length, 1, `exactly one notice expected, got: ${JSON.stringify(notices)}`);
        assert.match(
          notices[0],
          /sky module|@oai\/sky/i,
          `notice should name the sky package, got: ${notices[0]}`,
        );
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('a manifest whose main and bare exports name different files resolves the entry through main', async () => {
    const home = fakeCodexHome('main-entry', { replEntry: true, marketplace: true, mainOnlyEntry: true });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd: makeTempRoot('pi-cua-main-entry'),
        scripts: [{ kind: 'text', text: 'done' }],
      });
      try {
        await session.prompt('try computer use');
        // The manifest names its entry through both main (dist/main.js, on
        // disk) and a bare-string exports (dist/exports.js, absent): the
        // entry is main's file, discovery is complete, the tools register.
        const allNames = session.getAllTools().map((t) => t.name);
        assert.deepEqual(
          allNames.filter((n) => n.startsWith('computer_use')),
          ['computer_use', 'computer_use_reset'],
          'the manifest resolved its entry through main, so discovery must be complete',
        );
        const notices = session.notifications.map((n) => n.message);
        assert.equal(notices.length, 0, `no notice for a complete install, got: ${JSON.stringify(notices)}`);
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
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

  it('a complete installation registers the tools and the computer_use description names all three documents', async () => {
    // Complete on disk; the scripts hold no tool call, so no REPL launches —
    // registration and the description come from discovery alone.
    const prev = process.env.CODEX_HOME;
    const home = fakeCodexHome('complete', { replEntry: true, marketplace: true });
    process.env.CODEX_HOME = home;
    const cwd = makeTempRoot('pi-cua-complete-nolaunch');
    try {
      const { session } = await createScriptedSessionFromPackage({
        cwd,
        scripts: [ { kind: 'text', text: 'done' } ],
      });
      try {
        await session.prompt('try computer use');
        const allNames = session.getAllTools().map((t) => t.name);
        assert.deepEqual(
          allNames.filter((n) => n.startsWith('computer_use')),
          ['computer_use', 'computer_use_reset'],
          'a complete installation registers exactly the two computer-use tools',
        );
        const computerUse = session.getAllTools().find((t) => t.name === 'computer_use');
        assert.ok(computerUse, 'computer_use is registered on a complete installation');
        const d = computerUse.description;
        assert.match(d, /codex-computer-use/, 'description must tell the model to load the skill');
        assert.match(d, /computer_use_guidance_path/, 'description must name the guidance document');
        assert.match(d, /computer_use_confirmations_path/, 'description must name the confirmation policy');
        assert.match(d, /computer_use_sky_api_path/, 'description must name the sky API reference');
        const skyDoc = path.join(home, 'bin', 'node_modules', '@oai', 'sky', 'docs', 'sky-window2-api.md');
        assert.ok(d.includes(skyDoc), `description names the fake home's sky reference ${skyDoc}`);
        assert.ok(d.includes('guidance.md'), 'description names the guidance document');
        assert.ok(d.includes('confirmations.md'), 'description names the confirmation policy');
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  withRealRuntime('against the real home: computer_use runs and carries turn metadata', () => {
    it('valid home through a package session: computer_use runs against the real runtime and carries turn metadata', async () => {
      // The runtime resolves @oai/sky/service only from a trusted module
      // directory, which the real config names via NODE_REPL_TRUSTED_CODE_PATHS;
      // a migrated home carries the real env, so copy it too.
      const real = realCodexInstallation();
      if ('missing' in real) throw new Error(`needs a real Codex runtime: ${real.missing}`);
      const cwdHome = fakeCodexHome('valid', { replEntry: true, marketplace: true });
      const prev = process.env.CODEX_HOME;
      const nm = String(real.env['NODE_REPL_NODE_MODULE_DIRS']).replace(/'/g, String.fromCharCode(92) + String.fromCharCode(39));
      const command = String(real.command).replace(/'/g, String.fromCharCode(92) + String.fromCharCode(39));
      const tcp = String(real.env['NODE_REPL_TRUSTED_CODE_PATHS']).replace(/'/g, String.fromCharCode(92) + String.fromCharCode(39));
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
          // A call that lists apps succeeds against this home.
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
          const metaBody: unknown = jsonLine ? JSON.parse(jsonLine) : undefined;
          const meta: unknown = isRecord(metaBody) ? metaBody['x-codex-turn-metadata'] : undefined;
          assert.ok(meta, `second cell carried no turn metadata: ${text.slice(0, 200)}`);
          const metaTurnId: unknown = isRecord(meta) ? meta['turn_id'] : undefined;
          const metaSessionId: unknown = isRecord(meta) ? meta['session_id'] : undefined;
          assert.ok(metaTurnId, 'cell carries a per-run turn id');
          assert.equal(metaSessionId, session.sessionManager.getSessionId(), 'session_id is pi session id');
        } finally {
          await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
          session.dispose();
        }
      } finally {
        if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
      }
    });
  });
});
