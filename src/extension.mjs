// pi extension entry: registers computer_use, computer_use_reset, list_apps,
// and take_screenshot backed by the Codex REPL host; hides the tools behind a
// single notice when the Codex installation is incomplete (ticket #3) and
// wires the per-agent-run Escape stop (ticket #5).
// This is the ONLY file allowed to import pi.
import { ComputerUse } from './computer-use.mjs';
import { TurnMeta } from './turn-meta.mjs';
import { discover } from './discovery.mjs';
import { skillsDir } from './tools-dir.mjs';

// Single shared host + run identity for this pi process so tests and the
// extension agree on one REPL and one run registry.
export const computerUse = new ComputerUse();
export const turnMeta = new TurnMeta();

const TOOL_NAMES = ['computer_use', 'computer_use_reset', 'list_apps', 'take_screenshot'];// Map a thrown/host error to pi's tool-result error shape.
function errorResult(name, err) {
  return {
    content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
    details: undefined,
    isError: true,
  };
}

export default function (pi) {
  // Registering is unconditional; on an incomplete install the tools stay
  // hidden (never activate) and the session gets one notice naming the gap.
  // Keeping registration constant preserves the pi loader's registration
  // ordering while visibility is decided per-session at session_start.

  // Stop computer use for the rest of the current agent run. Called on the
  // Escape/abort signal and when a run ends; a new run clears the stop.
  const stopCurrentRun = () => {
    return computerUse.stopRun(turnMeta.runId);
  };

  pi.registerTool({
    name: 'computer_use',
    label: 'Computer use',
    // The description is the model's first route to the runtime. Name the REPL's
    // semantics here and point at the three Codex documents (their on-disk path
    // is reported by `computer_use_tool_paths`) and at the skill.
    description: [
      'Run a JavaScript cell in the Codex REPL to see and drive Windows desktop apps via Codex\'s sky library.',
      'REPL semantics: state persists on globalThis across cells; a cell returns text via nodeRepl.write(string). Before your first cell, load the codex-computer-use skill and read the three located Codex documents: computer_use_guidance_path, computer_use_confirmations_path, computer_use_sky_api_path.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript cell to run in the Codex REPL.' },
        timeout_ms: { type: 'number', description: 'Optional cell timeout in milliseconds.' },
      },
      required: ['code'],
    },
    execute: async (_toolCallId, params, signal) => {
      try {
        const { text, images } = await computerUse.runCell(params.code, { signal });
        const content = [{ type: 'text', text }];
        for (const img of images ?? []) {
          content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
        return { content, details: undefined };
      } catch (err) {
        return errorResult('computer_use', err);
      }
    },
  });

  pi.registerTool({
    name: 'computer_use_reset',
    label: 'Reset computer use',
    description: 'Reset the Codex REPL: drop all stored state and re-initialise sky.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        await computerUse.reset();
        return { content: [{ type: 'text', text: 'Codex REPL reset.' }], details: undefined };
      } catch (err) {
        return errorResult('computer_use_reset', err);
      }
    },
  });

  pi.registerTool({
    name: 'list_apps',
    label: 'List apps',
    description: 'List running desktop apps and their windows as text.',
    parameters: { type: 'object', properties: {} },
    execute: async (_toolCallId, _params, signal) => {
      try {
        computerUse._assertNotStopped(turnMeta.runId);
        const { text } = await computerUse.listApps({ signal });
        return { content: [{ type: 'text', text }], details: undefined };
      } catch (err) {
        return errorResult('list_apps', err);
      }
    },
  });

  pi.registerTool({
    name: 'take_screenshot',
    label: 'Take screenshot',
    description: 'Screenshot a desktop window; returns an image.',
    parameters: { type: 'object', properties: {} },
    execute: async (_toolCallId, _params, signal) => {
      try {
        computerUse._assertNotStopped(turnMeta.runId);
        const { text, images } = await computerUse.takeScreenshot({ signal });
        const content = [{ type: 'text', text }];
        for (const img of images) {
          content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
        return { content, details: undefined };
      } catch (err) {
        return errorResult('take_screenshot', err);
      }
    },
  });

  // Ticket #4: report the on-disk locations of the three discovered Codex
  // documents and this package's skills directory so the model can read the
  // guidance + confirmation policy + sky reference itself.
  pi.registerTool({
    name: 'computer_use_tool_paths',
    label: 'Computer use: tool paths',
    description: 'Report the on-disk paths of the located Codex documents and this extension\'s skills directory.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const found = discover();
        if (!found.ok) {
          return errorResult('computer_use_tool_paths', new Error('Codex installation incomplete: ' + found.missing.join(', ')));
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              computer_use_guidance_path: found.docs.guidance,
              computer_use_confirmations_path: found.docs.confirmationPolicy,
              computer_use_sky_api_path: found.docs.skyReference,
              computer_use_skills_dir: skillsDir,
              computer_use_skill: 'codex-computer-use',
            }),
          }],
          details: undefined,
        };
      } catch (err) {
        return errorResult('computer_use_tool_paths', err);
      }
    },
  });

  let noticed = false;

  // Ticket #3: incomplete install => hide the tools + one notice naming the gap.
  pi.on('session_start', (_event, ctx) => {
    const found = discover();
    if (found.ok) return; // complete install: tools stay active, no notice
    if (noticed) return; // one notice per extension lifetime
    noticed = true;
    const message = missingNotice(found.missing);
    const session = activeSession();
    if (session?.setActiveToolsByName) {
      session.setActiveToolsByName(session.getActiveToolNames().filter((n) => !TOOL_NAMES.includes(n)));
    }
    if (ctx?.ui?.notify) ctx.ui.notify(message, 'warning');
    else if (ctx?.uiContext?.notify) ctx.uiContext.notify(message, 'warning');
  });

  // Ticket #5: each new agent run (each prompt) begins a fresh run id;
  // computer use in this run is permitted again and carries run metadata.
  pi.on('agent_start', (_event, _ctx) => {
    turnMeta.beginRun();
  });

  // Run over (model finished): the run ends; any Escape stop on it dies here.
  pi.on('agent_end', (_event, _ctx) => {
    turnMeta.endRun();
  });

  // The physical Escape key aborts the model loop in the terminal; pi surfaces
  // that as abort — our signal to stop computer use for the rest of the run.
  pi.on('abort', (_event, _ctx) => {
    stopCurrentRun();
  });

  pi.on('session_shutdown', () => {
    // Kill the REPL process tree when the pi session ends.
    void computerUse.close();
  });

  // Re-export so tests/introspection can reach the live host + run identity.
  return { computerUse, turnMeta, missingNotice, get lastDiscovery() { return discover(); } };
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
