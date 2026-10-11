// Resolve the sky module path from the user's Codex config env.
// Uses [mcp_servers.node_repl.env] NODE_REPL_NODE_MODULE_DIRS (a node_modules
// directory or a delimiter-separated list of them) plus NODE_REPL_TRUSTED_SERVICES
// (JSON mapping service name -> module specifier, "sky" -> "@oai/sky/service").
// The @oai/sky package's "." export is the JS API used by cells.
// Host-logic file: must never import anything from pi. Zero dependencies.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { readTomlConfigDoc } from './config.mjs';

const SERVICE = 'sky';

export function resolveSkyModule(configEnv) {
  const services = JSON.parse(configEnv.NODE_REPL_TRUSTED_SERVICES ?? '{}');
  const specifier = services[SERVICE];
  if (!specifier) {
    throw new Error(`Cannot resolve ${SERVICE}: not listed in NODE_REPL_TRUSTED_SERVICES`);
  }
  // e.g. "@oai/sky/service" -> package name "@oai/sky"
  const pkgName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];

  // The REPL normalizes bases ending in node_modules to their dirname; both
  // spellings are accepted so the host finds the package under either.
  const candidateRoots = nodeModuleRoots(configEnv).map((root) =>
    path.join(root, pkgName));

  for (const dir of candidateRoots) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const main = pkg.exports?.['.'] ?? pkg.main;
    const sub = typeof main === 'string' ? main : main?.default;
    if (!sub) continue;
    const entry = path.join(dir, sub.replace(/^\.\//, ''));
    // A file URL (not a raw path) so characters like # or % survive, and
    // import() gets its argument as a string literal, not inline code.
    if (fs.existsSync(entry)) return pathToFileURL(entry).href;
  }
  throw new Error(`Cannot resolve ${SERVICE}: package ${pkgName} not found under NODE_REPL_NODE_MODULE_DIRS`);
}

// All node_modules roots the REPL can resolve packages from. Accepts a
// node_modules dir or a parent of one.
export function nodeModuleRoots(env) {
  return (env?.NODE_REPL_NODE_MODULE_DIRS ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => (path.basename(d) === 'node_modules' ? d : path.join(d, 'node_modules')));
}

// Windows writes the extended-length prefix \\?\ in front of long paths
// recorded in the config; strip it so the path opens normally.
const EXTENDED_PREFIX = String.fromCharCode(92, 92, 63, 92); // \\?\
function stripExtendedPrefix(p) {
  return p.startsWith(EXTENDED_PREFIX) ? p.slice(EXTENDED_PREFIX.length) : p;
}

// Marketplace and other package-source roots recorded in the Codex config
// (e.g. the bundled marketplace the computer-use plugin ships in). Reads the
// TOML-parsed document — the same parse src/config.mjs uses — so quoting,
// escapes, and the \?\ extended-length prefix are handled by the parser, not
// a regex. `[marketplaces.<name>] source = ...` (the real config's shape) and
// a bare `[marketplace] source = ...` are both accepted.
export function marketplaceRoots(doc) {
  const d = doc ?? readTomlConfigDoc();
  const tables = [d?.marketplaces, d?.marketplace].filter(
    (t) => t && typeof t === 'object',
  );
  return tables
    .flatMap((t) => (t.source !== undefined ? [t] : Object.values(t)))
    .map((e) => (typeof e?.source === 'string' ? stripExtendedPrefix(e.source) : null))
    .filter(Boolean);
}
