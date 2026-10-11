// Tests for the ReplHost over pi's MCP client: runCell with _meta turn
// metadata and timeout handling against the real Codex runtime.
// The REPL is never faked; these run locally with Codex installed and skip
// otherwise. The launch recipe itself is observable only through the runtime's
// behavior, which the package-session tests assert end to end.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readCodexConfig } from '../src/config.mjs';
import { ReplHost } from '../src/repl.mjs';

const hasRealRuntime = () => {
  try {
    const cfg = readCodexConfig();
    return !cfg.missing?.length && fs.existsSync(cfg.command);
  } catch {
    return false;
  }
};

const withRuntime = hasRealRuntime() ? describe : describe.skip;

const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');

withRuntime('ReplHost over pi-mcp against the real runtime', () => {
  let host;

  before(() => {
    host = new ReplHost();
  });

  after(async () => {
    await host.close();
  });

  it('runCell sends _meta turn metadata and the cell sees it as nodeRepl.requestMeta (no globalThis prefix)', async () => {
    const meta = { session_id: 'host-test-session', turn_id: 'host-test-run-1' };
    const r = await host.runCell('nodeRepl.write(JSON.stringify(nodeRepl.requestMeta))', { turnMeta: meta });
    assert.ok(!r?.isError, `cell failed: ${textOf(r)}`);
    const seen = JSON.parse(textOf(r));
    assert.deepEqual(seen, { 'x-codex-turn-metadata': meta }, 'requestMeta carries the nested _meta key');
  });

  it('runCell omits timeout_ms when none is given (runtime default applies)', async () => {
    // The runtime accepts the call; omitting timeout_ms must not error on a
    // required argument or a shorter host timeout. A quick cell proves it.
    const r = await host.runCell("nodeRepl.write('no-timeout ok')");
    assert.ok(!r?.isError, `cell failed: ${textOf(r)}`);
    assert.equal(textOf(r), 'no-timeout ok');
  });

  it('close() tears down the REPL process', async () => {
    assert.ok(host.running, 'REPL running before close');
    await host.close();
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(host.running, false, 'REPL no longer running after close');
  });
});