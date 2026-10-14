// Tests for how the package reads Codex's configuration, exercised only
// through a pi session: a temporary directory named by CODEX_HOME carries a
// config.toml the test writes itself — the package's parsing is observed
// through what the session does with it. The real runtime runs the cell; the
// fake home sits behind the session seam: the home, not the parsing
// function, is the independent statement of Codex's file
// layout. Needs the real runtime on this machine and skips visibly
// without it, like every runtime-gated suite.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { realCodexInstallation, withRealRuntime, makeTempRoot, createScriptedSession, toolResults, toolContentTexts, lastJsonObject } from './harness.js';

// A fake Codex home whose config.toml the test spells out itself. The
// [mcp_servers.node_repl] table names the real runtime's `command` so the
// session can actually launch it, keeping the exercise of the config's
// parsing; `env` carries the env block lines the test spells out itself —
// the [mcp_servers.node_repl.env] shape Codex itself writes; `topTables`
// carries the decoy top-level tables the launch must ignore.
function codexHome(label, { env = '', topTables = '' } = {}) {
  const home = makeTempRoot(`codex-home-${label}`);
  const real = realCodexInstallation();
  const quoted = (v) => String(v ?? '').replace(/\\/g, '\\\\');
  const envBlock = `NODE_REPL_NODE_MODULE_DIRS = '${quoted(real.env.NODE_REPL_NODE_MODULE_DIRS)}'
NODE_REPL_TRUSTED_CODE_PATHS = '${quoted(real.env.NODE_REPL_TRUSTED_CODE_PATHS)}'
NODE_REPL_NODE_PATH = '${quoted(real.env.NODE_REPL_NODE_PATH)}'
${env}`;
  // The bundled marketplace table, the shape Codex itself writes, pointing at
  // the real one: guidance and confirmation policy resolve from it. The REPL
  // entry, not this table, is what the tests observe.
  const marketplace = quoted(realCodexInstallationMarketplace()
    ?? path.dirname(path.dirname(path.dirname(real.command))));
  const toml = `${topTables}
[marketplaces.openai-bundled]
source = '${marketplace}'

[mcp_servers.node_repl]
command = '${quoted(real.command)}'
args = [${real.args.map((a) => `'${quoted(a)}'`).join(', ')}]

[mcp_servers.node_repl.env]
${envBlock}`;
  fs.writeFileSync(path.join(home, 'config.toml'), toml);
  return home;
}

// The bundled marketplace root, read from the real config without the
// package's code: the marketplace table's source points at the root holding
// plugins/computer-use/docs/guidance.md. null when none — callers decide.
function realCodexInstallationMarketplace() {
  const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  if (!fs.existsSync(file)) return null;
  const doc = parseToml(fs.readFileSync(file, 'utf8'));
  const tables = [doc?.marketplaces, doc?.marketplace].filter((t) => t && typeof t === 'object');
  for (const t of tables) {
    for (const e of (t.source !== undefined ? [t] : Object.values(t))) {
      const s = typeof e?.source === 'string' ? e.source.replace(/^\\\\\?\\/, '') : null;
      if (s && fs.existsSync(path.join(s, 'plugins', 'computer-use', 'docs', 'guidance.md'))) return s;
    }
  }
  return null;
}

// A cell that writes what the REPL launch made visible to it: whether sky is
// listed in the trusted services the config carried in.
const CONFIG_PROBE_CELL =
  "nodeRepl.write(JSON.stringify({ trusted: typeof globalThis.sky, mark: 'probe-ran' }));";

withRealRuntime('the Codex configuration is read from CODEX_HOME at each launch', () => {
  // One directory for the whole suite, removed with every other test
  // directory when the test process exits (test/harness.js).
  const root = makeTempRoot('pi-cua-config');

  it('the node_repl entry is applied: the session launches it and sky is configured from its env block', async () => {
    // The env key rides in the env sub-table, exactly where Codex writes it.
    const home = codexHome('entry', {
      env: `NODE_REPL_TRUSTED_SERVICES = '${JSON.stringify({ sky: '@oai/sky/service' }).replace(/'/g, "\\'")}'`,
    });
    const restore = setCodexHome(home);
    try {
      const { session } = await createScriptedSession({
        cwd: root,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: CONFIG_PROBE_CELL } },
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('run a cell');
        const [result] = toolResults(session);
        assert.ok(!result?.isError, `cell failed: ${toolContentTexts(result)}`);
        const observed = lastJsonObject(toolContentTexts(result));
        assert.equal(observed.trusted, 'object', 'sky was not configured from the node_repl env block');
        assert.match(toolContentTexts(result), /probe-ran/, 'the config-probe cell did not run');
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      restore();
    }
  });

  it('a config change between agent runs is picked up at the next launch', async () => {
    // One home, one session, two agent runs. The first cell runs against a
    // REPL whose config is complete. Then the test rewrites the same home's
    // config.toml so the sky module directory it names is bogus — a fresh
    // installation lookup cannot complete — and computer_use_reset tears
    // the REPL down. The next cell relaunches; only a re-read of the config
    // can fail the launch with the new file's problem, and the failure names
    // the cause (installation.ts's fail-fast check). A host that kept the
    // first launch's lookup would relaunch the old, valid configuration and
    // the cell would succeed.
    const home = codexHome('re-read', {
      env: `NODE_REPL_TRUSTED_SERVICES = '${JSON.stringify({ sky: '@oai/sky/service' }).replace(/'/g, "\\'")}'`,
    });
    const restore = setCodexHome(home);
    try {
      const { session } = await createScriptedSession({
        cwd: root,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: CONFIG_PROBE_CELL } },
          { kind: 'text', text: 'done' },
          { kind: 'tool', name: 'computer_use_reset' },
          { kind: 'tool', name: 'computer_use', args: { code: CONFIG_PROBE_CELL } },
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('run a cell');
        const [first] = toolResults(session);
        assert.ok(!first?.isError, `first cell failed: ${toolContentTexts(first)}`);
        const firstText = toolContentTexts(first);
        assert.ok(
          !firstText.startsWith('Codex REPL state was reset'),
          `the first cell must carry no reset notice: ${firstText}`,
        );
        const firstObserved = lastJsonObject(firstText);
        assert.equal(firstObserved.trusted, 'object', 'sky missing on the first launch');

        // The change: same home, same file, module directory now bogus.
        const configToml = path.join(home, 'config.toml');
        const before = fs.readFileSync(configToml, 'utf8');
        const marker = 'NODE_REPL_NODE_MODULE_DIRS';
        const start = before.indexOf(marker);
        assert.ok(start >= 0, 'fixture drift: module-dirs line not found in the written config');
        const lineEnd = before.indexOf('\n', start);
        const bogusDirs = JSON.stringify(path.join(home, 'no-such-node_modules'));
        const after = before.slice(0, start) + `${marker} = ${bogusDirs.replace(/\\/g, '\\\\')}` + before.slice(lineEnd);
        fs.writeFileSync(configToml, after);

        await session.prompt('reset the REPL and run the cell again');
        const results = toolResults(session);
        // The second run has two results: the reset, then the failed cell.
        assert.equal(results.length, 3, `reset plus cell expected across the runs, got ${results.length}`);
        const reset = results[1];
        assert.ok(!reset.isError, `reset failed: ${toolContentTexts(reset)}`);
        const second = results[2];
        assert.equal(
          second?.isError,
          true,
          `the relaunch ran despite the broken config (a stale cached lookup?): ${toolContentTexts(second)}`,
        );
        const secondText = toolContentTexts(second);
        // The relaunch also announces itself: the reset's next cell result
        // opens with the reset notice, even when the cell fails (the notice
        // leads the error message after the tool's `failed:` prefix).
        assert.match(secondText, /^computer_use failed: Codex REPL state was reset/, `failure carries no reset notice: ${secondText}`);
        assert.match(
          secondText,
          /@oai\/sky/, 
          `the failure must name the sky module the new config broke: ${secondText}`,
        );
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      restore();
    }
  });

  it('a missing config file is reported as one session notice naming it', async () => {
    // The home exists; its config.toml does not. The session starts anyway
    // (no tools, nothing to launch): one notice naming the missing config
    // file is sent through pi's ui surface, the same path pi's CLI shows
    // the user.
    const home = makeTempRoot('codex-home-missing-file');
    const restore = setCodexHome(home);
    try {
      const { session } = await createScriptedSession({
        cwd: root,
        scripts: [{ kind: 'text', text: 'done' }],
      });
      try {
        await session.prompt('try computer use');
        assert.equal(session.notifications.length, 1, `one notice expected, got: ${JSON.stringify(session.notifications)}`);
        assert.match(session.notifications[0].message, /incomplete/, 'the notice must say the installation is incomplete');
        assert.match(session.notifications[0].message, /config\.toml/, 'the notice must name the missing config file');
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      restore();
    }
  });

  it('an unparseable config file is reported as one session notice naming the parse failure', async () => {
    // A file that is not TOML: the session still starts and one notice names
    // the file and why it could not be used.
    const home = makeTempRoot('codex-home-unparseable');
    fs.writeFileSync(path.join(home, 'config.toml'), 'this is not TOML ]]\\][');
    const restore = setCodexHome(home);
    try {
      const { session } = await createScriptedSession({
        cwd: root,
        scripts: [{ kind: 'text', text: 'done' }],
      });
      try {
        await session.prompt('try computer use');
        assert.equal(session.notifications.length, 1, `one notice expected, got: ${JSON.stringify(session.notifications)}`);
        assert.match(session.notifications[0].message, /incomplete/, 'the notice must say the installation is incomplete');
        assert.match(session.notifications[0].message, /could not be parsed|parse/i, 'the notice must name the parse failure');
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      restore();
    }
  });

  it('escapes in TOML double-quoted strings are processed per TOML, not passed through literally', async () => {
    // The services JSON rides in a double-quoted TOML string, so every quote
    // it needs is an escaped \" — the original config case (spec story 23):
    // readCodexConfig had to turn "{\"sky\":\"@oai/sky/service\"}" into the
    // JSON the runtime reads. Escapes not processed would leave a value that
    // is not that JSON, and sky would not be configured from it.
    const home = codexHome('escapes', {
      env: 'NODE_REPL_TRUSTED_SERVICES = "{\\"sky\\":\\"@oai/sky/service\\"}"',
    });
    const restore = setCodexHome(home);
    try {
      const { session } = await createScriptedSession({
        cwd: root,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: CONFIG_PROBE_CELL } },
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('run a cell');
        const [result] = toolResults(session);
        assert.ok(!result?.isError, `cell failed: ${toolContentTexts(result)}`);
        const observed = lastJsonObject(toolContentTexts(result));
        assert.equal(observed.trusted, 'object', 'sky was not configured from the escaped double-quoted value');
        assert.match(toolContentTexts(result), /probe-ran/, 'the config-probe cell did not run');
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      restore();
    }
  });

  it('tables other than [mcp_servers.node_repl] are ignored by the launch', async () => {
    const home = codexHome('other-tables', {
      topTables: `[desktop]
command = 'C:\\bogus\\desktop-trap.exe'
args = ['/b']

[mcp_servers.other]
command = 'C:\\bogus\\other-trap.exe'
`,
      env: `NODE_REPL_TRUSTED_SERVICES = '${JSON.stringify({ sky: '@oai/sky/service' }).replace(/'/g, "\\'")}'`,
    });
    const restore = setCodexHome(home);
    try {
      const { session } = await createScriptedSession({
        cwd: root,
        scripts: [
          { kind: 'tool', name: 'computer_use', args: { code: CONFIG_PROBE_CELL } },
          { kind: 'text', text: 'done' },
        ],
      });
      try {
        await session.prompt('run a cell');
        const [result] = toolResults(session);
        assert.ok(!result?.isError, `cell failed despite decoy tables: ${toolContentTexts(result)}`);
        const observed = lastJsonObject(toolContentTexts(result));
        assert.equal(observed.trusted, 'object', 'sky missing — launch did not follow [mcp_servers.node_repl]');
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      restore();
    }
  });
});

// Point CODEX_HOME at `home` until the returned function restores the
// previous value (or unset). One save/restore per test.
function setCodexHome(home) {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  return () => {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  };
}