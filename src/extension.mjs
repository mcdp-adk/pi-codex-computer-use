// Pi extension: registers the two computer-use tools (computer_use,
// computer_use_reset) against the Codex REPL, and reacts to pi's session
// lifecycle. This file is pi's entry point; src/computer-use.mjs carries the
// host logic and never imports pi.
import { ComputerUse } from './computer-use.mjs';
import { TurnMeta } from './turn-meta.mjs';
import { discover } from './discovery.mjs';

export default function (pi, deps = {}) {
  const computerUse = deps.computerUse ?? new ComputerUse();
  const turnMeta = deps.turnMeta ?? new TurnMeta();
  const toolNames = ['computer_use', 'computer_use_reset'];

  // The always-visible computer_use description names the located guidance
  // files (ticket #4). Discovery runs once so the description refers to real
  // paths, not placeholders.
  const found = discover();
  const guidanceBlurb = found.ok
    ? ` Located: the guidance is \`${found.docs.guidance}\` (computer_use_guidance_path), the confirmation policy \`${found.docs.confirmationPolicy}\` (computer_use_confirmations_path), the sky API reference \`${found.docs.skyReference}\` (computer_use_sky_api_path).`
    : ' Codex installation looks incomplete; the tools may be hidden and a notice names what is missing.';

  pi.registerTool({
    name: 'computer_use',
    label: 'Computer use',
    description:
      'Run a JavaScript cell in the Codex computer-use REPL: top-level await works, bindings and values on globalThis persist between calls, only dynamic imports are available, and there is no `process`. Text the cell passes to nodeRepl.write comes back as tool result text; images it passes to nodeRepl.emitImage come back as images. The runtime applies its own default timeout; pass timeout_ms to override it. sky is already initialised. Load the codex-computer-use skill (skill: codex-computer-use) before the first cell.' + guidanceBlurb,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to run in the REPL' },
        timeout_ms: { type: 'number', description: 'Cell timeout in ms; defaults to the runtime’s own' },
      },
      required: ['code'],
    },
    // The model drives the desktop; each tool is model-only (not callable from
    // other tools), and cells run sequentially — one against the desktop at a time.
    exposure: 'model-only',
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      try {
        const meta = turnMeta.cellMeta();
        if (!meta.turn_id) throw new Error('computer-use has no active agent run; start a prompt first');
        const { text, content } = await computerUse.runCell(params.code, {
          signal,
          timeoutMs: params.timeout_ms,
          turnMeta: meta,
        });
        return { content: content ?? [{ type: 'text', text }], details: undefined };
      } catch (err) {
        return errorResult('computer_use', err);
      }
    },
  });

  pi.registerTool({
    name: 'computer_use_reset',
    label: 'Computer use: reset',
    description: 'Reset the Codex computer-use REPL: drops every binding and value on globalThis, and the next cell runs in a fresh REPL with sky initialised again by the host.',
    parameters: { type: 'object', properties: {} },
    exposure: 'model-only',
    executionMode: 'sequential',
    execute: async () => {
      try {
        const meta = turnMeta.cellMeta();
        if (!meta.turn_id) throw new Error('computer-use has no active agent run; start a prompt first');
        await computerUse.reset();
        return { content: [{ type: 'text', text: 'Codex REPL reset: a fresh REPL starts on the next cell.' }], details: undefined };
      } catch (err) {
        return errorResult('computer_use_reset', err);
      }
    },
  });

  // Ticket #3: an incomplete install hides the tools behind a single notice
  // naming what is missing, sent through pi's ui surface.
  let noticed = false;
  let lastNotice = null;
  pi.on('session_start', (_event, ctx) => {
    // SSOT: the pi session id names this host session to the runtime.
    if (ctx?.sessionManager?.getSessionId) turnMeta.setSessionId(ctx.sessionManager.getSessionId());
    const found = discover();
    if (found.ok || noticed) return;
    noticed = true;
    for (const name of toolNames) {
      const previous = pi.getAllTools().find((t) => t.name === name);
      if (previous) pi.registerTool({ ...previous, exposure: 'hidden', defaultActive: false });
    }
    lastNotice = missingNotice(found.missing);
    if (ctx?.ui?.notify) ctx.ui.notify(lastNotice, 'warning');
  });

  // Ticket #5: each agent run (each prompt) begins a fresh run identity; every
  // cell in it carries the run's Codex-style turn metadata.
  pi.on('agent_start', () => {
    turnMeta.beginRun();
  });

  // Run over — settled normally or aborted (physical Escape aborts the run):
  // signal turn_ended to the runtime, as Codex's own hooks do on Stop/Interrupt.
  pi.on('agent_settled', (event) => {
    const turnId = turnMeta.endRun();
    if (!turnId) return;
    const meta = { session_id: turnMeta.sessionId, turn_id: turnId };
    return computerUse.endRun(meta, { aborted: Boolean(event?.aborted) });
  });

  // Kill the REPL process tree when the pi session ends. Returning the promise
  // lets pi's shutdown await the teardown.
  pi.on('session_shutdown', () => computerUse.close());

  return {
    computerUse,
    turnMeta,
    get lastNotice() { return lastNotice; },
    get lastDiscovery() { return discover(); },
  };
}

// The notice names exactly what is missing from the Codex installation.
export function missingNotice(missing) {
  const list = missing.map((m) => `  - ${m}`).join('\n');
  return [
    'codex-computer-use: Codex installation is incomplete, computer-use tools are unavailable.',
    'Missing:',
    list,
  ].join('\n');
}

function errorResult(toolName, err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `${toolName} failed: ${message}` }],
    details: undefined,
    isError: true,
  };
}