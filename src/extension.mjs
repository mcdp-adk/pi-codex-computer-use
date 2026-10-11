// pi extension entry: registers computer_use, computer_use_reset,
// list_apps, and take_screenshot tools backed by the Codex REPL host. This
// is the ONLY file allowed to import pi.
import { ComputerUse } from './computer-use.mjs';

// Single shared host for this pi process so tests and the extension agree on
// one REPL; the default export (re)binds tools to this instance.
export const computerUse = new ComputerUse();

// Map a thrown/host error to pi's tool-result error shape.
function errorResult(name, err) {
  return {
    content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
    details: undefined,
    isError: true,
  };
}

export default function (pi) {

  pi.registerTool({
    name: 'computer_use',
    label: 'Computer use',
    description: 'Run a JavaScript cell in the Codex REPL to drive Windows desktop apps.',
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
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_toolCallId, _params, signal) => {
      try {
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
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_toolCallId, _params, signal) => {
      try {
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

  pi.on('session_shutdown', () => {
    // Kill the REPL process tree when the pi session ends.
    void computerUse.close();
  });

  // Re-export so tests/introspection can reach the live host via the module.
  return { computerUse };
}