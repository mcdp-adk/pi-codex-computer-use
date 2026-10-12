// Test harness: stands up a real pi SDK session with a faux provider that
// scripts tool calls against the real Codex runtime on this machine.
// The only fake here is the model boundary (faux provider with scripted
// streamSimple); the REPL, tools, and runtime are real.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  DefaultPackageManager,
  createAgentSession,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { AuthStorage } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';

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

// Create a temp directory under os.tmpdir(). With a node:test context,
// registers its removal after the test — every test removes what it creates.
export function makeTempRoot(label = 'pi-cua-test', t) {
  const root = path.join(os.tmpdir(), `${label}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  if (t) t.after(() => removeTempRoot(root));
  return root;
}

// Remove a directory makeTempRoot created. On Windows the REPL can still hold
// handles on it right after session_shutdown, so retry before giving up.
export function removeTempRoot(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
// The extension is loaded the way pi loads packages (package discovery on
// the package.json pi manifest) — never by importing src/extension.mjs
// directly, so the seam is exactly pi's.
export async function createScriptedSession({ scripts, cwd }) {
  return createScriptedSessionFromPackage({ scripts, cwd });
}

// The package-loading path itself: pi discovers the repo as a package and
// runs its extension factory from the manifest.
export async function createScriptedSessionFromPackage({ scripts, cwd }) {
  let remaining = [...scripts];
  const notifications = [];
  const streamSimple = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const next = remaining.shift() ?? { kind: 'text', text: 'done' };
    queueMicrotask(() => {
      const msg = pushScripted(stream, next);
      stream.end(msg);
    });
    return stream;
  };
  const packageExtensionFactory = async (pi) => {
    pi.registerProvider('faux', {
      api: 'faux-s',
      apiKey: 'test-key',
      models: [MODEL],
      streamSimple,
    });
  };
  const repoRoot = path.resolve(import.meta.dirname, '..');
  // SettingsManager.inMemory({ packages: [...] }) writes the packages list into
  // InMemorySettingsStorage under scope "global"; PackageManager reads the merged
  // settings to find the package sources. Do NOT wrap in { globalSettings: {...} }.
  const settingsManager = SettingsManager.inMemory({ packages: [repoRoot] });
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir: cwd,
    settingsManager,
    builtinExtensions: [],
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    packageManager,
    extensionFactories: [packageExtensionFactory],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'You are a test bot.',
  });
  await loader.reload();

  const er = loader.getExtensions();
  if (er.errors?.length) console.warn('[harness] package errors:', er.errors);

  const result = await createAgentSession({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    model: MODEL,
    // In-memory credentials + models store: the file-backed defaults lazily
    // write auth.json / models-store.json into agentDir (= cwd), recreating
    // the directory after its test has already removed it.
    modelRuntime: await ModelRuntime.create({ modelsPath: null, credentials: AuthStorage.inMemory() }),
  });
  const session = result.session ?? result;
  // Headless tests observe notices through the injected ui surface, like
  // pi's CLI does.
  session.notifications = notifications;
  // bindExtensions fires the session_start hook that pi's CLI would send.
  // The headless test harness must run it explicitly (print/json/rpc/tui all
  // do); the uiContext is injected so ctx.ui.notify can be observed.
  await session.bindExtensions({ uiContext: {
    notify: (message, level) => notifications.push({ message, level }),
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
  } });

  return { session, loader };
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