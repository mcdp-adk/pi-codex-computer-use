// One module locates the Codex installation. One lookup reads Codex's
// configuration (CODEX_HOME env or ~/.codex/config.toml) ONCE and answers
// with the REPL's command, Codex's configured environment for it, and the
// paths of the Codex guidance, the confirmation policy, and the sky API
// reference — or the list of what is missing, each piece named. It reports
// facts about Codex's files only; how the REPL is launched stays with the
// host (ADR 0002).
// Host-logic file: must never import anything from pi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

// The sky API reference sits next to the REPL module, under @oai/sky/docs in
// one of the node_modules directories the REPL resolves packages from.
const SKY_DOC = path.join('@oai', 'sky', 'docs', 'sky-window2-api.md');
// The Codex guidance and the confirmation policy ship in the bundled
// computer-use plugin, whose marketplace the config records.
const PLUGIN_DOCS = path.join('plugins', 'computer-use', 'docs');
// The trusted service the cells import sky through (NODE_REPL_TRUSTED_SERVICES).
const SKY_SERVICE = 'sky';

// Codex's configuration file: CODEX_HOME env or ~/.codex/config.toml.
function configPath() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

// Locate the Codex installation. Returns
// { ok: true, command, env, guidancePath, confirmationPolicyPath, skyReferencePath }
// or { ok: false, missing } naming exactly what is missing. Config problems
// and a missing REPL command are reported alone; the module, document, and
// plugin checks only run once a launchable command exists, so their failures
// join one list.
export function locateInstallation() {
  const file = configPath();
  if (!fs.existsSync(file)) return { ok: false, missing: ['Codex config file (config.toml)'] };
  let doc;
  try {
    doc = parseToml(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, missing: [`Codex config file could not be parsed (${err.message})`] };
  }
  const entry = doc.mcp_servers?.node_repl ?? {};
  if (!entry.command) return { ok: false, missing: ['[mcp_servers.node_repl] command in Codex config'] };
  if (!fs.existsSync(entry.command)) {
    return { ok: false, missing: [`node_repl command (${entry.command} not found)`] };
  }

  const env = entry.env && typeof entry.env === 'object'
    ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)]))
    : {};

  const missing = [];
  // The sky module: the check the sky init cell depends on, run at lookup
  // time — before any tool exists to run it — so a missing service entry or
  // package is named instead of failing deep inside a cell.
  try {
    checkSkyModule(env);
  } catch (err) {
    missing.push(`sky module (${err.message})`);
  }
  const skyReferencePath = skyModuleRoots(env)
    .map((root) => path.join(root, SKY_DOC))
    .find((p) => fs.existsSync(p)) ?? null;
  if (!skyReferencePath) missing.push('sky API reference (@oai/sky/docs/sky-window2-api.md next to the REPL)');
  const guidancePath = pluginDocPath('guidance.md', doc);
  if (!guidancePath) missing.push('Codex guidance (bundled computer-use plugin docs/guidance.md)');
  const confirmationPolicyPath = pluginDocPath('confirmations.md', doc);
  if (!confirmationPolicyPath) missing.push('confirmation policy (bundled computer-use plugin docs/confirmations.md)');

  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    command: entry.command,
    env,
    guidancePath,
    confirmationPolicyPath,
    skyReferencePath,
  };
}

// The sky module check: the @oai/sky package exists under one of the module
// directories the REPL resolves packages from, and the entry its manifest's
// `main` or `exports` names is on disk — a manifest-only shell (a half-copied
// install) is incomplete. The ONE place this is checked. Throws naming what
// is missing.
function checkSkyModule(env) {
  const packageName = skyPackageSpecifier(env);
  for (const root of skyModuleRoots(env)) {
    const dir = path.join(root, packageName);
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error(`Cannot resolve ${SKY_SERVICE}: ${packageName}'s package.json is not valid JSON`);
    }
    let entryFile;
    try {
      entryFile = manifestEntryPath(pkg);
    } catch (err) {
      throw new Error(`Cannot resolve ${SKY_SERVICE}: ${packageName}'s package.json names no usable entry (${err.message})`);
    }
    if (!fs.existsSync(path.join(dir, entryFile))) {
      throw new Error(`Cannot resolve ${SKY_SERVICE}: ${packageName}'s entry file ${entryFile} is missing`);
    }
    return dir;
  }
  throw new Error(`Cannot resolve ${SKY_SERVICE}: package ${packageName} not found under NODE_REPL_NODE_MODULE_DIRS`);
}

// The specifier cells import (e.g. "@oai/sky"), from NODE_REPL_TRUSTED_SERVICES
// (JSON mapping service name -> module specifier, "sky" -> "@oai/sky/service");
// the package name is the specifier up to the package boundary.
function skyPackageSpecifier(env) {
  const services = JSON.parse(env?.NODE_REPL_TRUSTED_SERVICES ?? '{}');
  const specifier = services[SKY_SERVICE];
  if (!specifier) {
    throw new Error(`Cannot resolve ${SKY_SERVICE}: not listed in NODE_REPL_TRUSTED_SERVICES`);
  }
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

// All node_modules roots the REPL can resolve packages from, from the config
// env's NODE_REPL_NODE_MODULE_DIRS (a node_modules dir or a delimiter-
// separated list of them; a parent of one is accepted).
function skyModuleRoots(env) {
  return (env?.NODE_REPL_NODE_MODULE_DIRS ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => (path.basename(d) === 'node_modules' ? d : path.join(d, 'node_modules')));
}

// The on-disk entry path a package's manifest names: a bare-string `exports`,
// the bare `main`, or the `.` export's value (a string, or the `default` of a
// conditional map). The export's leading `./` matches the manifest's own paths.
function manifestEntryPath(pkg) {
  const exp = pkg.exports;
  if (typeof exp === 'string') return exp;
  if (typeof pkg.main === 'string') return pkg.main;
  const dot = pkg.exports?.['.'];
  if (typeof dot === 'string') return dot;
  if (dot && typeof dot === 'object') {
    const dflt = dot.default ?? Object.values(dot).find((v) => typeof v === 'string');
    if (typeof dflt === 'string') return dflt;
  }
  throw new Error('no main and no "." export');
}

// A plugin document (guidance.md, confirmations.md) under the bundled
// computer-use plugin of the marketplaces recorded in the parsed config.
function pluginDocPath(name, doc) {
  for (const root of marketplaceRoots(doc)) {
    const p = path.join(root, PLUGIN_DOCS, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Marketplace and other package-source roots recorded in the parsed config
// (e.g. the bundled marketplace the computer-use plugin ships in).
// `[marketplaces.<name>] source = ...` (the real config's shape) and a bare
// `[marketplace] source = ...` are both accepted.
function marketplaceRoots(doc) {
  const tables = [doc?.marketplaces, doc?.marketplace].filter(
    (t) => t && typeof t === 'object',
  );
  return tables
    .flatMap((t) => (t.source !== undefined ? [t] : Object.values(t)))
    .map((e) => (typeof e?.source === 'string' ? stripExtendedPrefix(e.source) : null))
    .filter(Boolean);
}

// Windows writes the extended-length prefix \\?\ in front of long paths
// recorded in the config; strip it so the path opens normally.
const EXTENDED_PREFIX = String.fromCharCode(92, 92, 63, 92); // \\?\
function stripExtendedPrefix(p) {
  return p.startsWith(EXTENDED_PREFIX) ? p.slice(EXTENDED_PREFIX.length) : p;
}