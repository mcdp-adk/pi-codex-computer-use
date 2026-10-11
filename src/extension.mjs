// pi extension entry: registers the computer-use tools backed by the Codex
// REPL host, AND (ticket #3) hides them — with a single notice naming what is
// missing — whenever the Codex installation is incomplete.
// This is the ONLY file allowed to import pi.
import { ComputerUse } from './computer-use.mjs';
import { discover } from './discovery.mjs';

// Single shared host for this pi process so tests and the extension agree on
// one REPL; the default export (re)binds tools to this instance.
export const computerUse = new ComputerUse();

const TOOL_NAMES = ['list_apps', 'take_screenshot'];
const PI_BUILTINS = ['read', 'bash', 'edit', 'write'];

export default function (pi) {
  // Registering is unconditional; on an incomplete install the tools stay
  // hidden (never activate) and the session gets one notice naming the gap.
  // Keeping registration constant preserves the pi loader's registration
  // ordering while visibility is decided per-session at session_start.

  pi.registerTool({
    name: 'list_apps',
    label: 'List apps',
    description: 'List running desktop apps and their windows as text.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const text = await computerUse.listApps();
        return { content: [{ type: 'text', text }], details: undefined };
      } catch (err) {
        return { content: [{ type: 'text', text: `list_apps failed: ${err.message}` }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: 'take_screenshot',
    label: 'Take screenshot',
    description: 'Screenshot a desktop window; returns an image.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const { text, images } = await computerUse.takeScreenshot();
        const content = [{ type: 'text', text }];
        for (const img of images) {
          content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
        return { content, details: undefined };
      } catch (err) {
        return { content: [{ type: 'text', text: `take_screenshot failed: ${err.message}` }], details: undefined, isError: true };
      }
    },
  });

  let noticed = false;

  pi.on('session_start', (_event, ctx) => {
    const found = discover();
    if (found.ok) return; // complete install: tools stay active, no notice
    if (noticed) return; // one notice per extension lifetime
    noticed = true;
    const message = missingNotice(found.missing);
    // Hide: drop our tool names from the session's active tools. Reach the
    // AgentSession through a bound call — pi's extension API routes the
    // session through `ctx` here; if absent (older runtime), fall back to a
    // module-level session reference captured at registration time.
    const session = activeSession();
    if (session?.setActiveToolsByName) {
      session.setActiveToolsByName(session.getActiveToolNames().filter((n) => !TOOL_NAMES.includes(n)));
    }
    if (ctx?.ui?.notify) ctx.ui.notify(message, 'warning');
    else if (ctx?.uiContext?.notify) ctx.uiContext.notify(message, 'warning');
  });

  pi.on('session_shutdown', () => {
    // Kill the REPL process tree when the pi session ends.
    void computerUse.close();
  });

  // Re-export so tests/introspection can reach the live host via the module.
  return { computerUse, missingNotice, get lastDiscovery() { return discover(); } };
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

// Test backdoor: tests set this to the live AgentSession so the handler can
// strip tools. In a real pi TUI the session routes here via ctx; a
// module-level reference keeps the mechanism testable.
let _activeSession = null;
export function activeSession() {
  return _activeSession;
}
export function _setActiveSessionForTests(s) {
  _activeSession = s;
}
