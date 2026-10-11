// pi extension entry: registers the computer-use tools backed by the Codex
// REPL host, and (ticket #5) wires the per-agent-run Escape stop.
// This is the ONLY file allowed to import pi.
import { ComputerUse } from './computer-use.mjs';
import { TurnMeta } from './turn-meta.mjs';

// Single shared host + run identity for this pi process so tests and the
// extension agree on one REPL and one run registry.
export const computerUse = new ComputerUse();
export const turnMeta = new TurnMeta();

export default function (pi) {

  // Stop computer use for the rest of the current agent run. Called on the
  // Escape/abort signal and when a run ends; a new run clears the stop.
  const stopCurrentRun = (msg) => {
    const stopped = computerUse.stopRun(turnMeta.runId);
    return stopped;
  };

  pi.registerTool({
    name: 'list_apps',
    label: 'List apps',
    description: 'List running desktop apps and their windows as text.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        computerUse._assertNotStopped(turnMeta.runId);
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
        computerUse._assertNotStopped(turnMeta.runId);
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

  // Each new agent run (each prompt) begins a fresh run id; computer use in
  // this run is permitted again and carries the run as metadata.
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
  return { computerUse, turnMeta };
}
