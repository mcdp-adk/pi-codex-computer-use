// Tests for how the package reads Codex's configuration, exercised only
// through a pi session: a temporary directory named by CODEX_HOME carries a
// config.toml the test writes itself — the package's parsing is observed
// through what the session does with it. The real runtime runs the cell; the
// fake home sits behind the session seam (test-audit authoring gate: the
// home, not the parsing function, is the independent statement of Codex's
// file layout). Needs the real runtime on this machine and skips visibly
// without it, like every runtime-gated suite.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { realCodexInstallation, withRealRuntime, makeTempRoot, createScriptedSession, toolResults, toolContentTexts } from './harness.js';

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
    const restore = setCodeHome(home);
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

  it('a missing config file is reported to the model, not thrown', async () => {
    // The home exists; its config.toml does not. The session starts anyway
    // (no tools, nothing to launch): the model sees one notice naming the
    // missing config file.
    const home = makeTempRoot('codex-home-missing-file');
    const restore = setCodeHome(home);
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

  it('an unparseable config file is reported to the model, not thrown', async () => {
    // A file that is not TOML: the session still starts and one notice names
    // the file and why it could not be used.
    const home = makeTempRoot('codex-home-unparseable');
    fs.writeFileSync(path.join(home, 'config.toml'), 'this is not TOML ]]\\][');
    const restore = setCodeHome(home);
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
    const restore = setCodeHome(home);
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
    const restore = setCodeHome(home);
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

function setCodeHome(home) {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  return () => {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  };
}

// The last line of cell output that parses as a JSON object — the cell's own
// write, after any runtime echo lines.
function lastJsonObject(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) {
      try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
    }
  }
  return {};
}