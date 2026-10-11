// Codex installation discovery: the ONE place that resolves every
// piece of the Codex install this host depends on. Everything else asks this
// module; nothing re-derives paths on its own.
//
// Resolves, from the Codex config (CODEX_HOME env or ~/.codex/config.toml):
//   - the node_repl REPL entry (command, args, env) from [mcp_servers.node_repl]
//   - the sky module (@oai/sky) and its sky API reference, next to the REPL module
//   - the Codex guidance + confirmation policy, from the bundled computer-use plugin
// When any piece is missing, `discover()` reports exactly what, and the
// extension hides the computer-use tools behind a single notice.
// Host-logic file: must never import anything from pi. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { readCodexConfig } from './config.mjs';
import { resolveSkyModule, marketplaceRoots, nodeModuleRoots } from './sky-path.mjs';

const SKY_DOC = path.join('@oai', 'sky', 'docs', 'sky-window2-api.md');
const PLUGIN_DOCS = path.join('plugins', 'computer-use', 'docs');

// Return the REPL entry or, when unavailable, a `missing` list naming why.
export function discoverRepl() {
  const cfg = readCodexConfig();
  if (cfg.missing) return { missing: cfg.missing };
  const missing = [];
  if (!cfg.command || !fs.existsSync(cfg.command)) {
    missing.push(`node_repl command (${cfg.command ?? 'none'} not found)`);
  }
  if (missing.length) return { missing };
  return { command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {}, configFile: cfg.file };
}

// All node_modules roots the REPL can resolve packages from.

// The sky API reference sits next to the REPL module, under @oai/sky/docs.
// The config's NODE_REPL_NODE_MODULE_DIRS points at ONE node_modules dir;
// the doc lives under @oai/sky/docs in it.
export function skyReferencePath(env) {
  for (const root of nodeModuleRoots(env ?? {})) {
    const p = path.join(root, SKY_DOC);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The plugins of the marketplaces recorded in the Codex config (e.g. the
// bundled marketplace the computer-use plugin ships in).
function findPluginDoc(name) {
  for (const root of marketplaceRoots()) {
    const p = path.join(root, PLUGIN_DOCS, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function guidancePath() {
  return findPluginDoc('guidance.md');
}

export function confirmationPolicyPath() {
  return findPluginDoc('confirmations.md');
}

// Discover the whole installation. Returns { ok:true, repl, docs } or
// { ok:false, missing:[...named pieces...] }; on ok, `docs` holds the three
// model-facing document paths.
export function discover() {
  const repl = discoverRepl();
  const missing = [...(repl.missing ?? [])];
  let docs = {};
  if (!repl.missing) {
    // The sky module: resolve it exactly as ensureSky will, so a missing
    // NODE_REPL_TRUSTED_SERVICES entry or package is named here, before any
    // tool runs.
    try {
      resolveSkyModule(repl.env);
    } catch (err) {
      missing.push(`sky module (${err.message})`);
    }
    const skyRef = skyReferencePath(repl.env);
    if (!skyRef) missing.push('sky API reference (@oai/sky/docs/sky-window2-api.md next to the REPL)');
    else docs.skyReference = skyRef;
    const guidance = guidancePath();
    if (!guidance) missing.push('Codex guidance (bundled computer-use plugin docs/guidance.md)');
    else docs.guidance = guidance;
    const confirmation = confirmationPolicyPath();
    if (!confirmation) missing.push('confirmation policy (bundled computer-use plugin docs/confirmations.md)');
    else docs.confirmationPolicy = confirmation;
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, repl, docs };
}