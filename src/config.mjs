// Single small module that locates the Codex node_repl MCP server config.
// Reads the user's Codex config file (CODEX_HOME env or ~/.codex/config.toml)
// and extracts [mcp_servers.node_repl]: command, args, env block.
// Ticket #3 will centralize discovery; keep this module tiny.
// Host-logic file: must never import anything from pi. Zero dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function configPath() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

export function readCodexConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return { file, missing: ['Codex config file (config.toml)'] };
  const toml = fs.readFileSync(file, 'utf8');
  const cfg = parse(toml);
  if (!cfg.command) return { file, missing: ['[mcp_servers.node_repl] command in Codex config'] };
  return { file, command: cfg.command, args: cfg.args, env: cfg.env };
}

// Parse only the node_repl bits of the config — enough for this ticket.
// Handles basic TOML single-line tables: key = "value" | 'value' | [a, b].
export function parse(toml) {
  const lines = toml.split(/\r?\n/);
  let inHdr = false;
  let inEnv = false;
  const cfg = { command: null, args: [], env: {} };
  for (const l0 of lines) {
    const l = l0.trim();
    if (l.startsWith('[')) {
      inHdr = l === '[mcp_servers.node_repl]';
      inEnv = l === '[mcp_servers.node_repl.env]';
      continue;
    }
    if (l.startsWith('#') || !l) continue;
    const kv = l.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2].trim();
    if (inHdr) {
      if (key === 'command') cfg.command = unquote(raw);
      else if (key === 'args') cfg.args = parseArray(raw);
    } else if (inEnv) {
      cfg.env[key] = unquote(raw);
    }
  }
  return cfg;
}

// Comment block sits above `parse` (the TOML reader); unquote/parseArray
// below are its helpers. Double-quoted TOML strings process \-escapes (so
// "C:\\x" becomes C:\x and "{\"k\":\"v\"}" becomes {"k":"v"} — both
// JSON-parseable after unquoting).
function unquote(s) {
  const m = s.match(/^'(.*)'$/) ?? s.match(/^"(.*)"$/);
  if (!m) return s;
  const inner = m[1];
  // Single-quoted TOML strings are literal; no escape processing.
  if (s[0] === "'") return inner;
  // Double-quoted: process the standard TOML escapes.
  return inner.replace(/\\(.)/g, (whole, ch) => {
    switch (ch) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      case '"': return '"';
      case "'": return "'";
      case 'b': return '\b';
      case 'f': return '\f';
      case 'u': return '\\u'; // not implemented; keep for parse error visibility
      default: return ch;
    }
  });
}

function parseArray(s) {
  const m = s.match(/\[([^\]]*)\]/);
  if (!m || !m[1].trim()) return [];
  return m[1].split(',').map((x) => unquote(x.trim())).filter(Boolean);
}