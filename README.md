# pi-codex-computer-use

A [pi](https://pi.dev) package that lets pi drive Windows desktop apps through the computer-use runtime bundled with the Codex desktop app.

It talks to Codex's own `node_repl` MCP server, where the model writes JavaScript against `@oai/sky`, the same way Codex uses it.

## Requirements

- Windows
- The [Codex desktop app](https://openai.com/codex), installed locally and signed in once (so Codex writes its configuration)

This package ships no Codex files. It discovers and runs the Codex runtime already installed on your machine.

## Install

```sh
git clone https://github.com/mcdp-adk/pi-codex-computer-use.git
cd pi-codex-computer-use
npm install
pi install ./path/to/pi-codex-computer-use
```

`pi install` adds the package to your settings; the extension registers the `computer_use` / `computer_use_reset` tools, and the `codex-computer-use` skill becomes available to the model.

## Use

The tools are not registered (with a single notice naming what is missing) until the Codex installation is complete; then the model can run cells in the Codex REPL. The model loads the `codex-computer-use` skill before its first cell; the skill points at the Codex guidance, confirmation policy, and sky API reference in the Codex installation, and lists where driving the runtime from pi differs from driving it inside Codex.

## Tests

```sh
npm test
```

`test/computer-use.test.js` and `test/reset-abort.test.js` run against the real Codex runtime and require a signed Codex installation; they skip cleanly when one is not present.
