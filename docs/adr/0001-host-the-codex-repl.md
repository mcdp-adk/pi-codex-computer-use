# Host the Codex REPL instead of building our own

pi gets computer use by hosting the REPL from the Codex runtime and letting the model write cells against sky, exactly as Codex does, rather than talking to the helper directly, writing our own REPL, or adopting another driver. The Codex runtime's own guidance forbids custom helper clients, the REPL gives us the persistent state and isolation the guidance assumes, and the point of the project is to reuse OpenAI's tuned behavior, not to reinvent it.

## Considered Options

- Talking to the helper directly: forbidden by Codex's guidance, and loses the runtime's app approval handling.
- Our own REPL: the most code to maintain and the most drift from Codex.
- cua-driver: the owner found it not good enough for their apps.
- The newer `cua_repl` runtime: on Windows it is a thin layer over the same sky and helper, and the Codex app enables it only for browsers, so using it for desktop apps would mean editing a generated manifest after every update.
