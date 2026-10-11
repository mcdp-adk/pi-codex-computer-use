// Observation (issue #6): does an aborted cell keep running in the REPL?
// Runs a 20s cell that would write a marker file, aborts the pi agent run
// mid-cell, then checks twice whether the marker file appears.
import fs from 'node:fs';
import { makeTempRoot, createScriptedSession, toolResults, toolContentTexts } from './harness.js';

const wait = async (pred, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
};

const root = makeTempRoot('pi-cua-obs');
const marker = `${root}/marker-after-abort.txt`;
const code = `await new Promise(r => setTimeout(r, 20000)); (await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'survived');`;
const { session } = await createScriptedSession({
  cwd: root,
  scripts: [
    { kind: 'tool', name: 'computer_use', args: { code, timeout_ms: 400000 } },
    { kind: 'text', text: 'finished' },
  ],
});
const mod = await import('../src/extension.mjs');
const cu = mod.computerUse;
const promptPromise = session.prompt('long cell then abort');
await wait(() => cu.host.running && cu.host.client?.proc?.pid, 30000);
const t0 = Date.now();
await session.abort();
await promptPromise;
console.log('abort elapsed ms:', Date.now() - t0);
const results = toolResults(session);
results.forEach((r, i) => console.log('result', i, r.isError, JSON.stringify(toolContentTexts(r).slice(0, 160))));
session.dispose();
console.log('t+0s  marker exists:', fs.existsSync(marker));
await new Promise((r) => setTimeout(r, 15000));
console.log('t+15s marker exists:', fs.existsSync(marker), '(cell sleeps 20s; if still running it would not have written yet)');
await new Promise((r) => setTimeout(r, 12000));
console.log('t+27s marker exists:', fs.existsSync(marker), '(cell would have finished at ~t+20s if it kept running)');
process.exit(0);