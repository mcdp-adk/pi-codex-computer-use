# pi-codex-computer-use

A [pi](https://pi.dev) package that lets pi drive Windows desktop apps through the computer-use runtime bundled with the Codex desktop app.

It talks to Codex's own `node_repl` MCP server, where the model writes JavaScript against `@oai/sky`, the same way Codex uses it.

## Status

Early development. Not usable yet.

## Requirements

- Windows
- The Codex desktop app, installed locally

This package ships no Codex files. It locates and runs the Codex runtime already installed on your machine.
