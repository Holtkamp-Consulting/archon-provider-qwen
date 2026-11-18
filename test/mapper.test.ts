import { describe, expect, test } from 'bun:test';
import { providerChunkSchema } from '@archon/provider-contract';
import { QwenStreamMapper, HEARTBEAT_INTERVAL_MS } from '../src/stream';
import { toolRestrictionArgs, toolRestrictionViolation, QWEN_KNOWN_TOOL_NAMES } from '../src/tools';
import { classFromHttpStatus, classFromExitCode } from '../src/failure';
import { parseStructuredText } from '../src/structured';
import { buildArgs } from '../src/provider';

const line = (value: unknown): string => JSON.stringify(value);

describe('QwenStreamMapper', () => {
  test('coalesces text, skips whitespace-only blocks and maps usage', () => {
    const mapper = new QwenStreamMapper({ toolRestrictions: {}, wantsStructuredOutput: false, freshSessionId: 'fresh' });
    const out = [
      ...mapper.line(line({ type: 'system', subtype: 'init', session_id: 's-1', model: 'm', tools: [] })),
      ...mapper.line(line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '\n\n' }] } })),
      ...mapper.line(line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Hi' }] } })),
      ...mapper.line(line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: ' there' }] } })),
      ...mapper.line(line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'Hi there', session_id: 's-1', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4, total_tokens: 12 } })),
      ...mapper.finish({}),
    ];
    for (const chunk of out) expect(providerChunkSchema.safeParse(chunk).success).toBe(true);
    expect(out).toEqual([
      { type: 'agent_message_chunk', text: 'Hi there' },
      {
        type: 'result',
        sessionId: 's-1',
        text: 'Hi there',
        tokens: { input: 10, output: 2, cacheRead: 4, total: 12 },
        numTurns: 1,
        resolvedModel: { id: 'm' },
        stopReason: 'end_turn',
      },
    ]);
  });

  test('ignores sub-agent traffic apart from heartbeats', () => {
    let now = 0;
    const mapper = new QwenStreamMapper({ toolRestrictions: {}, wantsStructuredOutput: false, now: () => now });
    now = HEARTBEAT_INTERVAL_MS + 1;
    expect(mapper.line(line({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', id: 'c', name: 'read_file' }] } }))).toEqual([{ type: 'heartbeat' }]);
    expect(mapper.line(line({ type: 'stream_event', event: {} }))).toEqual([]);
  });

  test('a model Qwen Code did not select is a misconfiguration', () => {
    const mapper = new QwenStreamMapper({ requestedModel: 'wanted', toolRestrictions: {}, wantsStructuredOutput: false });
    mapper.line(line({ type: 'system', subtype: 'init', session_id: 's', model: 'other', tools: [] }));
    expect(mapper.fatalCondition?.failure.class).toBe('misconfigured');
    const [result] = mapper.finish({});
    expect(result).toMatchObject({ type: 'result', isError: true, errorSubtype: 'model_not_selected' });
  });
});

describe('tool restrictions', () => {
  test('an allowlist also excludes every other known tool', () => {
    const args = toolRestrictionArgs({ allowed: ['read_file'], denied: ['edit'] });
    expect(args.slice(0, 2)).toEqual(['--core-tools', 'read_file']);
    const excluded = args.filter((_, i) => args[i - 1] === '--exclude-tools');
    expect(excluded).toContain('edit');
    expect(excluded).toContain('agent');
    expect(excluded).not.toContain('read_file');
    expect(excluded.length).toBe(QWEN_KNOWN_TOOL_NAMES.length - 1);
  });

  test('the reported tool list is checked against the restrictions', () => {
    expect(toolRestrictionViolation({ allowed: ['read_file'] }, ['read_file', 'structured_output'])).toBeUndefined();
    expect(toolRestrictionViolation({ allowed: ['read_file'] }, ['read_file', 'agent'])).toContain('agent');
    expect(toolRestrictionViolation({ denied: ['edit'] }, ['edit'])).toContain('edit');
  });
});

describe('classification and parsing', () => {
  test('HTTP status and exit code classes', () => {
    expect([401, 403, 402, 404, 429, 503, 529, 500, 400].map(classFromHttpStatus)).toEqual([
      'auth', 'auth', 'quota_exhausted', 'misconfigured', 'rate_limited', 'overloaded', 'overloaded', 'transient', 'unknown',
    ]);
    expect([42, 44, 52, 55, 1, null].map(classFromExitCode)).toEqual([
      'misconfigured', 'misconfigured', 'misconfigured', 'budget_exceeded', 'unknown', 'unknown',
    ]);
  });

  test('structured text fallback', () => {
    expect(parseStructuredText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseStructuredText('Here you go: {"a":2}')).toEqual({ a: 2 });
    expect(parseStructuredText('[1,2]')).toBeUndefined();
    expect(parseStructuredText('no json')).toBeUndefined();
  });

  test('arguments: prompt never in argv, model only when configured', () => {
    const fresh = buildArgs(undefined, {}, () => 'id-1');
    expect(fresh.args).toContain('--session-id');
    expect(fresh.args).not.toContain('--model');
    const resumed = buildArgs('abc', { assistantConfig: { model: 'm' }, forkSession: true, appendSystemPrompt: 'extra' });
    expect(resumed.args).toEqual(expect.arrayContaining(['--resume', 'abc', '--fork-session', '--model', 'm', '--append-system-prompt', 'extra']));
    const system = buildArgs(undefined, { systemPrompt: ['a', 'b'], appendSystemPrompt: 'ignored' });
    expect(system.args).toEqual(expect.arrayContaining(['--system-prompt', 'a\n\nb']));
    expect(system.args).not.toContain('--append-system-prompt');
  });
});
