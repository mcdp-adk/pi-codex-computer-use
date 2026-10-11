// Resolve the sky module path from the user's Codex config env.
// Uses [mcp_servers.node_repl.env] NODE_REPL_NODE_MODULE_DIRS (a node_modules
// directory or a delimiter-separated list of them) plus NODE_REPL_TRUSTED_SERVICES
// (JSON mapping service name -> module specifier, "sky" -> "@oai/sky/service").
// The @oai/sky package's "." export is the JS API used by cells.
// Ticket #3 will centralize discovery; keep this module tiny.
// Host-logic file: must never import anything from pi. Zero dependencies.
import path from 'node:path';
import fs from 'node:fs';
import { nodeModuleRoots } from './discovery.mjs';

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
    if (fs.existsSync(entry)) return pathToFileUrlString(entry);
  }
  throw new Error(`Cannot resolve ${SERVICE}: package ${pkgName} not found under NODE_REPL_NODE_MODULE_DIRS`);
}

function pathToFileUrlString(p) {
  let url = p.replace(/\\/g, '/');
  if (!url.startsWith('/')) url = '/' + url;
  return 'file://' + url;
}