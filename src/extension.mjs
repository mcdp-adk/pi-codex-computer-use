// pi extension entry: registers list_apps and take_screenshot tools backed by
// the Codex REPL host. This is the ONLY file allowed to import pi.
import { ComputerUse } from './computer-use.mjs';

// Single shared host for this pi process so tests and the extension agree on
// one REPL; the default export (re)binds tools to this instance.
export const computerUse = new ComputerUse();

export default function (pi) {

  pi.registerTool({
    name: 'list_apps',
    label: 'List apps',
    description: 'List running desktop apps and their windows as text.',
    parameters: {
      type: 'object',
      properties: {},
    },
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
    parameters: {
      type: 'object',
      properties: {},
    },
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

  pi.on('session_shutdown', () => {
    // Kill the REPL process tree when the pi session ends.
    void computerUse.close();
  });

  // Re-export so tests/introspection can reach the live host via the module.
  return { computerUse };
}