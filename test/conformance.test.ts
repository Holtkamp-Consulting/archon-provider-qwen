import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { IAgentProvider, ProviderChunk, SendQueryOptions } from '@archon/provider-contract';
import { runProviderConformance, checkCredentialStatuses } from '@archon/provider-contract/conformance';
import { connectProvider, type ConnectedProvider } from '@archon/provider-contract/plugin';
import { create, descriptor } from '../src/main';
import { alive, collect, prompt, sandbox, withEnv, type Sandbox } from './helpers';

const ROOT = join(import.meta.dir, '..');
/** Set ARCHON_PROVIDER_QWEN_BINARY to test a prebuilt executable (CI does). */
const BINARY = process.env.ARCHON_PROVIDER_QWEN_BINARY ?? join(ROOT, 'dist', 'test', 'archon-provider-qwen');
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, ok: { type: 'boolean' } },
  required: ['answer', 'ok'],
};

type Provider = Pick<IAgentProvider, 'sendQuery'>;

function suite(provider: Provider, box: Sandbox, resumeId: string, includeInProcessOnly: boolean) {
  const run = (scenario: string, options: SendQueryOptions = {}, resume?: string) => () =>
    provider.sendQuery(prompt(scenario), box.cwd, resume, withEnv(box, options));
  const failure = (name: string, expected: Parameters<typeof runProviderConformance>[0]['failureCases'][number]['expected'], evidence: string, scenario: string, options: SendQueryOptions = {}) => ({
    name,
    expected,
    evidence,
    run: run(scenario, options),
  });
  return runProviderConformance({
    capabilities: descriptor.capabilities,
    turns: [
      { name: 'text', run: run('text') },
      { name: 'tools', run: run('tool') },
      { name: 'structured', run: run('structured', { outputFormat: { type: 'json_schema', schema: SCHEMA } }) },
      { name: 'structured-text', run: run('structured-text', { outputFormat: { type: 'json_schema', schema: SCHEMA } }) },
      { name: 'resume', run: run('text', {}, resumeId) },
      { name: 'configured model', run: run('text', { assistantConfig: { model: 'fake/model-a' } }) },
    ],
    toolTurn: { name: 'interrupted tool', run: run('tool-interrupted') },
    failureCases: [
      failure('auth', 'auth', 'HTTP 401', 'http-401'),
      failure('rate limit', 'rate_limited', 'HTTP 429', 'http-429'),
      failure('overloaded', 'overloaded', 'HTTP 503', 'http-503'),
      failure('server error', 'transient', 'HTTP 500', 'http-500'),
      failure('budget', 'budget_exceeded', 'code 55', 'exit-55'),
      failure('config', 'misconfigured', 'code 52', 'exit-52'),
      failure('unknown model', 'misconfigured', 'nope/model', 'text', { model: 'nope/model' }),
      ...(includeInProcessOnly
        ? [failure('missing binary', 'misconfigured', 'ARCHON_QWEN_PATH', 'text', { env: { ARCHON_QWEN_PATH: '/nonexistent/qwen' } })]
        : []),
    ],
  });
}

async function newSession(provider: Provider, box: Sandbox): Promise<string> {
  const chunks = await collect(provider.sendQuery(prompt('text'), box.cwd, undefined, withEnv(box)));
  const result = chunks.find(chunk => chunk.type === 'result');
  if (result?.type !== 'result' || !result.sessionId) throw new Error('no session');
  return result.sessionId;
}

/** Drop fields that legitimately differ between runs (fresh session ids). */
function normalize(chunks: ProviderChunk[]): unknown[] {
  return chunks.map(chunk => (chunk.type === 'result' && chunk.sessionId ? { ...chunk, sessionId: '<id>' } : chunk));
}

describe('in process', () => {
  const box = sandbox();
  afterAll(() => box.cleanup());

  test('conforms', async () => {
    const provider = create();
    const resumeId = await newSession(provider, box);
    expect(await suite(provider, box, resumeId, true)).toEqual([]);
  });

  test('credential check never spends a session', async () => {
    const provider = create();
    expect(
      await checkCredentialStatuses([
        { name: 'native', expected: 'not_checked', secret: 'sk-never', check: () => provider.checkCredential({ env: { ...box.env, OPENAI_API_KEY: 'sk-never' }, signal: new AbortController().signal }) },
        { name: 'no cli', expected: 'check_failed', secret: 'sk-never', check: () => provider.checkCredential({ env: { ARCHON_QWEN_PATH: '/nonexistent/qwen', OPENAI_API_KEY: 'sk-never' }, signal: new AbortController().signal }) },
      ])
    ).toEqual([]);
  });

  test('maps a tool turn', async () => {
    const chunks = await collect(create().sendQuery(prompt('tool'), box.cwd, undefined, withEnv(box)));
    expect(chunks.map(chunk => chunk.type)).toEqual(['tool_call', 'tool_call_update', 'tool_call', 'tool_call_update', 'agent_message_chunk', 'result', 'settled']);
    expect(chunks[3]).toMatchObject({ toolCallId: '102', status: 'failed', output: 'Command exited with code 1' });
  });

  test('structured output comes from the structured_output call, else from the reply text', async () => {
    const options = withEnv(box, { outputFormat: { type: 'json_schema', schema: SCHEMA } });
    const viaTool = await collect(create().sendQuery(prompt('structured'), box.cwd, undefined, options));
    expect(viaTool).toContainEqual({ type: 'tool_call_update', toolCallId: '301', status: 'completed' });
    expect(viaTool.find(chunk => chunk.type === 'result')).toMatchObject({ structuredOutput: { answer: 'forty-two', ok: true } });
    const viaText = await collect(create().sendQuery(prompt('structured-text'), box.cwd, undefined, options));
    expect(viaText.find(chunk => chunk.type === 'result')).toMatchObject({ structuredOutput: { answer: 'from text', ok: false } });
  });

  test('resume keeps the session id; a missing session is reported structurally', async () => {
    const provider = create();
    const id = await newSession(provider, box);
    const resumed = await collect(provider.sendQuery(prompt('text'), box.cwd, id, withEnv(box)));
    expect(resumed.find(chunk => chunk.type === 'result')).toMatchObject({ sessionId: id, resumed: true });
    const missing = await collect(provider.sendQuery(prompt('text'), box.cwd, '11111111-2222-3333-4444-555555555555', withEnv(box)));
    expect(missing).toEqual([
      expect.objectContaining({ type: 'result', isError: true, sessionNotFound: true, resumed: false, failure: expect.objectContaining({ class: 'unknown' }) }),
      { type: 'settled' },
    ]);
  });

  test('tool restrictions reach qwen and are verified', async () => {
    const ok = await collect(create().sendQuery(prompt('text'), box.cwd, undefined, withEnv(box, { nodeConfig: { allowed_tools: ['read_file', 'edit'], denied_tools: ['edit'] } })));
    // `edit` is both allowed and denied: denied wins, qwen starts without it.
    expect(ok.find(chunk => chunk.type === 'result')).toMatchObject({ text: 'Hello from fake qwen.' });
  });

  test('cancellation kills the qwen process tree and never settles', async () => {
    const pidfile = join(box.root, 'hang.pid');
    const abort = new AbortController();
    const chunks: ProviderChunk[] = [];
    const stream = create().sendQuery(prompt('hang'), box.cwd, undefined, withEnv(box, { abortSignal: abort.signal, env: { FAKE_QWEN_PIDFILE: pidfile } }));
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunk.type === 'tool_call') {
        while (!existsSync(pidfile) || readFileSync(pidfile, 'utf8').split(' ').length < 2) await Bun.sleep(10);
        abort.abort();
      }
    }
    const pids = readFileSync(pidfile, 'utf8').split(' ').map(Number);
    await Bun.sleep(100);
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(chunks.map(chunk => chunk.type)).toEqual(['tool_call', 'tool_call_update']);
    expect(chunks[1]).toMatchObject({ status: 'cancelled' });
  });
});

describe('compiled executable', () => {
  const box = sandbox();
  let child: ChildProcess;
  let client: ConnectedProvider;
  let closed: Promise<void>;

  beforeAll(async () => {
    if (!process.env.ARCHON_PROVIDER_QWEN_BINARY) {
      mkdirSync(join(ROOT, 'dist', 'test'), { recursive: true });
      const build = spawnSync(process.execPath, ['build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--outfile', BINARY, join(ROOT, 'src', 'main.ts')], { cwd: ROOT, encoding: 'utf8' });
      if (build.status !== 0) throw new Error(`compile failed: ${build.stderr}`);
    }
    // The executable gets the fake qwen through its own environment, as Archon's host does.
    child = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...box.env } });
    closed = new Promise(resolve => child.once('close', () => resolve()));
    client = await connectProvider({ readable: Readable.toWeb(child.stdout!) as never, writable: Writable.toWeb(child.stdin!) as never });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await closed;
    box.cleanup();
  });

  test('advertises the descriptor', () => {
    expect(client.getCapabilities()).toEqual(descriptor.capabilities);
    expect(client.getType()).toBe('qwen');
  });

  test('conforms', async () => {
    const resumeId = await newSession(client, box);
    expect(await suite(client, box, resumeId, false)).toEqual([]);
  });

  test('streams the same chunks as the in-process provider', async () => {
    for (const scenario of ['text', 'tool', 'tool-interrupted', 'http-401', 'exit-55']) {
      const direct = await collect(create().sendQuery(prompt(scenario), box.cwd, undefined, withEnv(box)));
      const remote = await collect(client.sendQuery(prompt(scenario), box.cwd, undefined, withEnv(box)));
      expect(normalize(remote)).toEqual(normalize(direct));
    }
  });

  test('cancellation over the wire kills the process tree', async () => {
    const pidfile = join(box.root, 'hang-remote.pid');
    // The executable's environment is fixed at spawn, so the pidfile path comes from a
    // second executable started with it.
    const remoteChild = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...box.env, FAKE_QWEN_PIDFILE: pidfile } });
    const remoteClosed = new Promise<void>(resolve => remoteChild.once('close', () => resolve()));
    const remote = await connectProvider({ readable: Readable.toWeb(remoteChild.stdout!) as never, writable: Writable.toWeb(remoteChild.stdin!) as never });
    try {
      const abort = new AbortController();
      const chunks: ProviderChunk[] = [];
      for await (const chunk of remote.sendQuery(prompt('hang'), box.cwd, undefined, { abortSignal: abort.signal })) {
        chunks.push(chunk);
        if (chunk.type === 'tool_call') {
          while (!existsSync(pidfile) || readFileSync(pidfile, 'utf8').split(' ').length < 2) await Bun.sleep(10);
          abort.abort();
        }
      }
      const pids = readFileSync(pidfile, 'utf8').split(' ').map(Number);
      await Bun.sleep(200);
      for (const pid of pids) expect(alive(pid)).toBe(false);
      expect(chunks.some(chunk => chunk.type === 'settled' || chunk.type === 'result')).toBe(false);
    } finally {
      await remote.close();
      await remoteClosed;
    }
  });
});
