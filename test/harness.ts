// Test harness: stands up a real pi SDK session with a faux provider that
// scripts tool calls against the real Codex runtime on this machine.
// The only fake here is the model boundary (faux provider with scripted
// streamSimple); the REPL, tools, and runtime are real.
// The harness also owns what the suites share: the ONE check that the real
// Codex runtime is available (its own reading of the real Codex installation,
// written without the package's code so a broken package fails tests instead
// of skipping them), and the process-tree helpers the suites watch
// processes with.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { describe } from 'node:test';
import { parse as parseToml } from 'smol-toml';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  JsonObject,
  Model,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import {
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, ExtensionAPI, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
// AuthStorage is not re-exported from the package index, so the harness
// reaches the same module pi itself loads, by the path that exists at
// runtime — never `any`, and never through the package under test.
import { AuthStorage } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';

// Parsed JSON and TOML start as unknown; this is the narrowing gate the
// harness and the suites share.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MODEL: Model<Api> = {
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

// The faux model boundary carries one field pi's own types do not know: a
// persist flag on the message. It rides the wire object the harness has
// always built, so the message type extends pi's with it instead of
// asserting it away. (The totalTokens tally travels in pi's own Usage.)
interface FauxAssistantMessage extends AssistantMessage {
  persist: boolean;
}

const MSG_BASE = (): FauxAssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'faux-s',
  provider: 'faux',
  model: 'faux-1',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: Date.now(),
  persist: true,
});

// Every test directory lives under one per-process root, removed once at
// process exit — not per test. On Windows the REPL can still hold handles on
// a directory right after session_shutdown, so the removal retries.
const TEST_ROOT = path.join(os.tmpdir(), `pi-codex-computer-use-test-${process.pid}`);
let exitHookRegistered = false;

// Create a temp directory under the process's per-run test root. No node:test
// context, no per-test removal: one `process.on('exit')` removes the root.
export function makeTempRoot(label = 'pi-cua-test'): string {
  const root = path.join(TEST_ROOT, `${label}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on('exit', () => {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  }
  return root;
}

// Scripted response: either { kind:'tool', name, args, text? } or { kind:'text', text }.
type ScriptedResponse =
  | { kind: 'tool'; name: string; args?: JsonObject; text?: string }
  | { kind: 'text'; text?: string };

function pushScripted(stream: AssistantMessageEventStream, next: ScriptedResponse): FauxAssistantMessage {
  let msg: FauxAssistantMessage;
  if (next.kind === 'tool') {
    const tc: ToolCall = { type: 'toolCall', id: `tc-${Math.random().toString(36).slice(2, 8)}`, name: next.name, arguments: next.args ?? {} };
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

// A headless session: pi's own session with one extra surface the tests
// observe — the notices the injected ui surface collected, the way pi's CLI
// shows them to the user.
type ScriptedSession = AgentSession & {
  notifications: Array<{ message: string; level: string | undefined }>;
};

// Creates a pi session whose provider scripts the given responses in order.
// `scripts` entries are consumed by the faux streamSimple per prompt turn.
// The extension is loaded the way pi loads packages (package discovery on
// the package.json pi manifest) — never by importing src/extension.ts
// directly, so the seam is exactly pi's.
export async function createScriptedSession({ scripts, cwd }: { scripts: ScriptedResponse[]; cwd: string }) {
  return createScriptedSessionFromPackage({ scripts, cwd });
}

// The package-loading path itself: pi discovers the repo as a package and
// runs its extension factory from the manifest.
export async function createScriptedSessionFromPackage({ scripts, cwd }: { scripts: ScriptedResponse[]; cwd: string }) {
  const remaining: ScriptedResponse[] = [...scripts];
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const next: ScriptedResponse = remaining.shift() ?? { kind: 'text', text: 'done' };
    queueMicrotask(() => {
      const msg = pushScripted(stream, next);
      stream.end(msg);
    });
    return stream;
  };
  const packageExtensionFactory = async (pi: ExtensionAPI) => {
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
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
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
  // Headless tests observe notices through the injected ui surface, like
  // pi's CLI does; the session type does not carry that test surface, so it
  // is asserted narrowly here, never `any`.
  const session = (result.session ?? result) as ScriptedSession;
  session.notifications = notifications;
  // bindExtensions fires the session_start hook that pi's CLI would send.
  // The headless test harness must run it explicitly (print/json/rpc/tui all
  // do); the uiContext is injected so ctx.ui.notify can be observed. Only the
  // dialogs the tests observe are implemented, so the partial surface is
  // asserted to pi's ui context type instead of faking the whole CLI.
  await session.bindExtensions({ uiContext: {
    notify: (message: string, level?: 'info' | 'warning' | 'error') => { notifications.push({ message, level }); },
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
  } as unknown as ExtensionUIContext });

  return { session, loader };
}

// Collects tool results from session messages: role 'toolResult' messages.
export function toolResults(session: AgentSession): ToolResultMessage[] {
  return session.messages.filter((m): m is ToolResultMessage => m.role === 'toolResult');
}

export function toolContentTexts(result: ToolResultMessage): string {
  return (result?.content ?? []).filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('\n');
}

export function toolContentImages(result: ToolResultMessage): ImageContent[] {
  return (result?.content ?? []).filter((c): c is ImageContent => c.type === 'image');
}

// The last line of cell output that parses as a JSON object — the cell's own
// write, after any runtime echo lines.
export function lastJsonObject(text: string): Record<string, unknown> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(lines[i]);
        if (isRecord(parsed)) return parsed;
      } catch { /* keep looking */ }
    }
  }
  return {};
}

// ---- The real Codex installation ----

interface CodexInstallationFound {
  file: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface CodexInstallationMissing {
  missing: string;
}

// The harness's own reading of the real Codex installation — deliberately not
// the package's code: a broken package must fail these tests, not skip them.
// Parses Codex's own configuration (CODEX_HOME or ~/.codex/config.toml) and
// answers with the node_repl server entry, or with the reason the runtime is
// unusable.
export function realCodexInstallation(): CodexInstallationFound | CodexInstallationMissing {
  const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  if (!fs.existsSync(file)) return { missing: `no Codex config file at ${file}` };
  let doc: unknown;
  try {
    doc = parseToml(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { missing: `Codex config file ${file} does not parse (${err instanceof Error ? err.message : String(err)})` };
  }
  const servers: unknown = isRecord(doc) ? doc['mcp_servers'] : undefined;
  const entry: unknown = isRecord(servers) ? servers['node_repl'] : undefined;
  if (!isRecord(entry) || !entry['command']) {
    return { missing: `no [mcp_servers.node_repl] command in ${file}` };
  }
  const command = String(entry['command']);
  if (!fs.existsSync(command)) {
    return { missing: `node_repl command ${command} does not exist` };
  }
  const args: unknown = entry['args'];
  const env: unknown = entry['env'];
  return {
    file,
    command,
    args: Array.isArray(args) ? args.map(String) : [],
    env: isRecord(env)
      ? Object.fromEntries(Object.entries(env).map(([k, v]): [string, string] => [k, String(v)]))
      : {},
  };
}

// Gates a suite on a real Codex runtime: with one, the suite runs; without,
// it skips visibly with the reason. The one availability check every suite
// goes through.
export function withRealRuntime(name: string, fn: () => void) {
  const install = realCodexInstallation();
  return 'missing' in install
    ? describe(name, { skip: `needs a real Codex runtime: ${install.missing}` }, fn)
    : describe(name, fn);
}

// ---- Process-tree helpers (shared by the suites that watch processes) ----

interface ProcEntry {
  ProcessId: number;
  ParentProcessId: number;
  Name?: string;
}

function asProcEntry(value: unknown): ProcEntry {
  if (!isRecord(value)) throw new Error(`malformed process snapshot: ${JSON.stringify(value)}`);
  const pid: unknown = value['ProcessId'];
  const parentPid: unknown = value['ParentProcessId'];
  if (typeof pid !== 'number' || typeof parentPid !== 'number') {
    throw new Error(`malformed process snapshot: ${JSON.stringify(value)}`);
  }
  const name: unknown = value['Name'];
  return {
    ProcessId: pid,
    ParentProcessId: parentPid,
    ...(typeof name === 'string' ? { Name: name } : {}),
  };
}

export function procSnapshot(): ProcEntry[] {
  const out = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"',
    { encoding: 'utf8' },
  );
  const parsed: unknown = JSON.parse(out);
  // PowerShell ConvertTo-Json returns a single object rather than an array
  // for one row, as the original harness handled; anything else shaped
  // wrong throws below instead of passing on a bad observation.
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(asProcEntry);
}

export function replProcPids(): number[] {
  return procSnapshot().filter((p) => /node_repl/i.test(p.Name ?? '')).map((p) => p.ProcessId);
}

// Kill a process and its whole tree: the snapshot cannot tell the REPL top
// process from its own helper child, and killing only the child leaves
// the top process alive — the host sees no exit, no relaunch, no notice.
// The handle is stringified, so anything the suites pass (a pid, or the
// abort test's wait handle) resolves the same way taskkill would.
export function killTree(pid: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    t.on('exit', resolve);
    t.on('error', resolve);
  });
}

export async function waitUntil(pred: () => unknown, timeoutMs: number, stepMs = 100): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}
