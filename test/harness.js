// Test harness: stands up a real pi SDK session with a faux provider that
// scripts tool calls against the real Codex runtime on this machine.
// The only fake here is the model boundary (faux provider with scripted
// streamSimple); the REPL, tools, and runtime are real.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { createAgentSession } from '@earendil-works/pi-coding-agent';

export const MODEL = {
  id: 'faux-1',
  name: 'Faux 1',
  api: 'faux-s',
  provider: 'faux',
  baseUrl: 'http://localhost:0',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
  reasoning: false,
};

const MSG_BASE = () => ({
  role: 'assistant',
  content: [],
  api: 'faux-s',
  provider: 'faux',
  model: 'faux-1',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  stopReason: 'stop',
  timestamp: Date.now(),
  persist: true,
});

export function makeTempRoot(label = 'pi-cua-test') {
  const root = path.join(os.tmpdir(), `${label}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Scripted response: either { kind:'tool', name, args, text? } or { kind:'text', text }.
function pushScripted(stream, next) {
  let msg;
  if (next.kind === 'tool') {
    const tc = { type: 'toolCall', id: `tc-${Math.random().toString(36).slice(2, 8)}`, name: next.name, arguments: next.args ?? {} };
    msg = { ...MSG_BASE(), content: [{ type: 'text', text: next.text ?? 'calling tool' }, tc], stopReason: 'toolUse' };
    stream.push({ type: 'start', partial: msg });
    stream.push({ type: 'toolcall_start', contentIndex: 1, partial: msg });
    stream.push({ type: 'toolcall_end', contentIndex: 1, toolCall: tc, partial: msg });
    stream.push({ type: 'done', reason: 'toolUse', message: msg });
  } else {
    msg = { ...MSG_BASE(), content: [{ type: 'text', text: next.text ?? 'done' }], stopReason: 'stop' };
    stream.push({ type: 'start', partial: msg });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: next.text ?? 'done', partial: msg });
    stream.push({ type: 'done', reason: 'stop', message: msg });
  }
  return msg;
}

// Creates a pi session whose provider scripts the given responses in order.
// `scripts` entries are consumed by the faux streamSimple per prompt turn.
export async function createScriptedSession({ scripts, cwd }) {
  let remaining = [...scripts];
  const streamSimple = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const next = remaining.shift() ?? { kind: 'text', text: 'done' };
    queueMicrotask(() => {
      const msg = pushScripted(stream, next);
      stream.end(msg);
    });
    return stream;
  };

  const extensionFactory = async (pi) => {
    pi.registerProvider('faux', {
      api: 'faux-s',
      apiKey: 'test-key',
      models: [MODEL],
      streamSimple,
    });
    const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'src', 'extension.mjs')));
    mod.default(pi);
  };

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({}),
    extensionFactories: [extensionFactory],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'You are a test bot.',
  });
  await loader.reload();

  return createAgentSession({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    model: MODEL,
  });
}

// Collects tool results from session messages: role 'toolResult' messages.
export function toolResults(session) {
  return session.messages.filter((m) => m.role === 'toolResult');
}

export function toolContentTexts(result) {
  return (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export function toolContentImages(result) {
  return (result?.content ?? []).filter((c) => c.type === 'image');
}