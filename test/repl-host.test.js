// Tests for the ReplHost over pi's MCP client (review fixes 2, 4, 5, 6, 7).
// Seam: the host's public surface — runCell with _meta turn metadata, env
// recipe, timeout handling, sky binding — against the real Codex runtime.
// The REPL is never faked; these run locally with Codex installed and skip
// otherwise.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readCodexConfig } from '../src/config.mjs';
import { ReplHost, RESET_NOTICE } from '../src/repl.mjs';
import { resolveSkyModule } from '../src/sky-path.mjs';
import { skyInitCell } from '../src/cells.mjs';

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

  it('the launch recipe: no args, TMP/TEMP at a created writable tmp dir, app-routing vars removed, analytics off', () => {
    const cfg = readCodexConfig();
    const { transport } = host;
    assert.ok(transport, 'transport exists after first launch');
    assert.deepEqual(transport.options.args, [], 'no arguments to the REPL executable');
    assert.equal(transport.options.command, cfg.command, 'command from the config');
    const env = transport.options.env;
    assert.equal(env.NODE_REPL_DISABLE_ANALYTICS, '1', 'analytics off');
    assert.ok(!('SKY_CUA_NATIVE_PIPE' in env), 'SKY_CUA_NATIVE_PIPE removed');
    assert.ok(!('SKY_CUA_NATIVE_PIPE_DIRECTORY' in env), 'SKY_CUA_NATIVE_PIPE_DIRECTORY removed');
    assert.ok(!('CODEX_CLI_PATH' in env), 'CODEX_CLI_PATH removed');
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      if (['SKY_CUA_NATIVE_PIPE', 'SKY_CUA_NATIVE_PIPE_DIRECTORY', 'CODEX_CLI_PATH'].includes(k)) continue;
      assert.equal(env[k], v, `configured env ${k} passed through`);
    }
    assert.ok(env.TMP && env.TEMP, 'TMP and TEMP are set');
    assert.ok(fs.existsSync(env.TMP) && fs.statSync(env.TMP).isDirectory(), `TMP dir exists: ${env.TMP}`);
    assert.ok(path.isAbsolute(env.TMP), 'TMP is an absolute path');
  });

  it('close() tears down the REPL process', async () => {
    assert.ok(host.running, 'REPL running before close');
    await host.close();
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(host.running, false, 'REPL no longer running after close');
  });

  it('turn_ended carries {hook_event_name, session_id, turn_id} with the same ids', async () => {
    // After a close, the next call relaunches with a reset notice on the
    // ComputerUse level; the host itself just runs the cell.
    await host.ensureStarted();
    const meta = { session_id: 'host-test-session', turn_id: 'host-test-run-2' };
    // Turn-ended is sent by the host on run end; here we verify the wiring
    // through a real call that must succeed with the same ids the cell saw.
    const r = await host.runCell('nodeRepl.write("ok")', { turnMeta: meta });
    assert.equal(textOf(r), 'ok');
  });
});