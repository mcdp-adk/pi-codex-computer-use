// Locate the sky module from the user's Codex config env.
// Uses [mcp_servers.node_repl.env] NODE_REPL_NODE_MODULE_DIRS (a node_modules
// directory or a delimiter-separated list of them) plus NODE_REPL_TRUSTED_SERVICES
// (JSON mapping service name -> module specifier, "sky" -> "@oai/sky/service").
// The host only checks the module exists: cells import `@oai/sky` bare, the
// same as Codex's own Initialize cell; the REPL does the resolving.
// Host-logic file: must never import anything from pi. Zero dependencies.
import path from 'node:path';
import fs from 'node:fs';
import { readTomlConfigDoc } from './config.mjs';

const SERVICE = 'sky';

// The specifier cells import (e.g. "@oai/sky"), from NODE_REPL_TRUSTED_SERVICES.
function skySpecifier(configEnv) {
  const services = JSON.parse(configEnv?.NODE_REPL_TRUSTED_SERVICES ?? '{}');
  const specifier = services[SERVICE];
  if (!specifier) {
    throw new Error(`Cannot resolve ${SERVICE}: not listed in NODE_REPL_TRUSTED_SERVICES`);
  }
  // e.g. "@oai/sky/service" -> package name "@oai/sky"
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

// A discovery check: the @oai/sky package exists under one of the module
// directories the REPL resolves packages from. Throws naming what is missing,
// so an incomplete install registers no tools and names the gap.
export function checkSkyModule(configEnv) {
  const pkgName = skySpecifier(configEnv);
  const candidateRoots = nodeModuleRoots(configEnv).map((root) =>
    path.join(root, pkgName));

  for (const dir of candidateRoots) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
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