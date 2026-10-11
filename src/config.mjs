// Single small module that locates the Codex node_repl MCP server config.
// Reads the user's Codex config file (CODEX_HOME env or ~/.codex/config.toml)
// and extracts [mcp_servers.node_repl]: command, args, env block.
// Parsing is smol-toml's; no hand-rolled TOML here.
// Host-logic file: must never import anything from pi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

function configPath() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

export function readTomlConfigDoc() {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  try {
    return parseToml(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function readCodexConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return { file, missing: ['Codex config file (config.toml)'] };
  const toml = fs.readFileSync(file, 'utf8');
  let doc;
  try {
    doc = parseToml(toml);
  } catch (err) {
    return { file, missing: [`Codex config file could not be parsed (${err.message})`] };
  }
  const entry = doc.mcp_servers?.node_repl ?? {};
  if (!entry.command) return { file, missing: ['[mcp_servers.node_repl] command in Codex config'] };
  return {
    file,
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: entry.env && typeof entry.env === 'object' ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) : {},
  };
}