// Tests for src/config.mjs: TOML parsing of the Codex configuration.
// smol-toml is the parser; readCodexConfig keeps its shape.
// Behavior is asserted through readCodexConfig with a doctored CODEX_HOME.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readCodexConfig } from '../src/config.mjs';
import { makeTempRoot } from './harness.js';

function codexHomeWith(toml) {
  const home = makeTempRoot('codex-home-cfg');
  fs.writeFileSync(path.join(home, 'config.toml'), toml);
  return home;
}

describe('config: TOML parsing of the Codex configuration', () => {
  it('readCodexConfig extracts the node_repl entry, ignoring other tables', () => {
    const home = codexHomeWith(`
model = "gpt-6.1-sol"
command = "top-level-trap"
[desktop]
command = "desktop-trap"
args = ["/b"]
[mcp_servers.node_repl]
command = 'C:\\codex\\node_repl.exe'
args = ["--flag"]
startup_timeout_sec = 120
[mcp_servers.node_repl.env]
NODE_REPL_NODE_PATH = 'C:\\codex\\node.exe'
NODE_REPL_TRUSTED_SERVICES = "{\\"sky\\":\\"@oai/sky/service\\"}"
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"
[mcp_servers.other]
command = "other-trap"
`);
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const cfg = readCodexConfig();
      assert.equal(cfg.missing, undefined);
      assert.equal(cfg.command, 'C:\\codex\\node_repl.exe', 'command from the node_repl table, not a stray top-level key');
      assert.deepEqual(cfg.args, ['--flag']);
      assert.equal(cfg.env.NODE_REPL_NODE_PATH, 'C:\\codex\\node.exe');
      assert.equal(cfg.env.NODE_REPL_TRUSTED_SERVICES, '{"sky":"@oai/sky/service"}', 'double-quoted escapes processed per TOML');
      assert.equal(cfg.env.BROWSER_USE_AVAILABLE_BACKENDS, 'chrome,iab,mcpapps');
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('readCodexConfig reports a missing config file', () => {
    const home = makeTempRoot('codex-home-missing');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const cfg = readCodexConfig();
      assert.match(cfg.missing[0], /config/i);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  it('readCodexConfig reports an unparseable config file instead of throwing', () => {
    const home = codexHomeWith('this is = not toml ==\n[');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const cfg = readCodexConfig();
      assert.match(cfg.missing?.[0] ?? '', /parsed/i, 'parse failure becomes a missing reason, not a throw');
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });
});
