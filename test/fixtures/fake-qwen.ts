/**
 * A stand-in for the `qwen` CLI that replays stream-json shaped like Qwen Code 0.24.6
 * output (recorded against LM Studio and a stub OpenAI endpoint, with message text
 * replaced). The scenario is the first line of the prompt on stdin: `scenario:<name>`.
 * It honors the flags the provider passes that change Qwen Code's observable behavior:
 * --session-id, --resume, --model, --core-tools, --exclude-tools, --json-schema.
 *
 * Environment: QWEN_HOME (transcript root, required), FAKE_QWEN_PIDFILE (hang scenario).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MODEL = 'fake/default-model';
const CONFIGURED_MODELS = new Set([DEFAULT_MODEL, 'fake/model-a']);
const ALL_TOOLS = [
  'read_file', 'zoom_image', 'read_mcp_resource', 'skill', 'grep_search', 'glob', 'cron_create',
  'cron_list', 'cron_delete', 'list_agents', 'task_stop', 'send_message', 'notebook_edit',
  'enter_worktree', 'exit_worktree', 'record_artifact', 'loop_wakeup', 'get_goal', 'update_goal',
  'tool_call', 'agent', 'write_file', 'run_shell_command', 'report_findings', 'monitor',
  'web_fetch', 'tool_search', 'edit',
];
// Tools --core-tools does not remove (observed with qwen 0.24.6).
const ALWAYS_ON = new Set([
  'skill', 'list_agents', 'task_stop', 'send_message', 'enter_worktree', 'exit_worktree',
  'record_artifact', 'get_goal', 'update_goal', 'tool_call', 'agent', 'report_findings', 'tool_search',
]);

function flagValues(name: string): string[] {
  const values: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) values.push(...argv[i + 1].split(','));
  }
  return values;
}
const flag = (name: string): string | undefined => flagValues(name)[0];
const hasFlag = (name: string): boolean => process.argv.includes(name);

const qwenHome = process.env.QWEN_HOME;
if (!qwenHome) {
  process.stderr.write('fake-qwen: QWEN_HOME is required\n');
  process.exit(2);
}
const chatsDir = join(qwenHome, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
const transcriptFor = (id: string): string => join(chatsDir, `${id}.jsonl`);

const resume = flag('--resume');
if (resume !== undefined && !existsSync(transcriptFor(resume))) {
  process.stderr.write(`No saved session found with title "${resume}".\n`);
  process.exit(1);
}
const sessionId = resume !== undefined && hasFlag('--fork-session') ? randomUUID() : (resume ?? flag('--session-id') ?? randomUUID());
mkdirSync(chatsDir, { recursive: true });
const transcript = transcriptFor(sessionId);

const prompt = await new Response(Bun.stdin.stream()).text();
const scenario = /^scenario:(\S+)/.exec(prompt)?.[1] ?? 'text';
appendFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId, message: { role: 'user', parts: [{ text: '<prompt>' }] } })}\n`);

const requestedModel = flag('--model');
const model = requestedModel !== undefined && CONFIGURED_MODELS.has(requestedModel) ? requestedModel : DEFAULT_MODEL;
const core = flagValues('--core-tools');
const excluded = new Set(flagValues('--exclude-tools'));
let tools = ALL_TOOLS.filter(tool => !excluded.has(tool));
if (core.length > 0) tools = tools.filter(tool => core.includes(tool) || ALWAYS_ON.has(tool));
if (hasFlag('--json-schema')) tools.push('structured_output');

const emit = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...line, session_id: sessionId })}\n`);
};
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const assistant = (content: unknown[], usage = { input_tokens: 0, output_tokens: 0 }): void =>
  emit({ type: 'assistant', uuid: uuid(), parent_tool_use_id: null, message: { id: uuid(), type: 'message', role: 'assistant', model, content, stop_reason: null, usage } });
const toolResult = (id: string, content: string, isError = false): void =>
  emit({ type: 'user', uuid: uuid(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
const usage = { input_tokens: 1200, output_tokens: 34, cache_read_input_tokens: 0, total_tokens: 1234 };
const success = (result: string, extra: Record<string, unknown> = {}, turns = 1): void =>
  emit({ type: 'result', subtype: 'success', uuid: uuid(), is_error: false, duration_ms: 10, duration_api_ms: 8, num_turns: turns, result, usage, permission_denials: [], ...extra });
const apiFailure = (status: number, errorType: string): void => {
  appendFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'ui_telemetry', sessionId, systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_error', 'event.timestamp': new Date().toISOString(), model, error_message: `${status} upstream said no`, error_type: errorType, status_code: status } } })}\n`);
  assistant([{ type: 'text', text: `[API Error: ${status} upstream said no]` }]);
  emit({ type: 'result', subtype: 'error_during_execution', uuid: uuid(), is_error: true, duration_ms: 5, duration_api_ms: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, permission_denials: [], error: { message: `[API Error: ${status} upstream said no]` } });
};

emit({ type: 'system', subtype: 'init', uuid: sessionId, cwd: process.cwd(), tools, mcp_servers: [], model, permission_mode: 'yolo', qwen_code_version: '0.24.6' });
emit({ type: 'stream_event', uuid: uuid(), parent_tool_use_id: null, event: { type: 'goal_state', goal_state: { v: 2, goal: null, activity: 'idle' } } });

const http = /^http-(\d{3})$/.exec(scenario);
const exitCode = /^exit-(\d+)$/.exec(scenario);
if (http) {
  const status = Number(http[1]);
  apiFailure(status, status === 401 ? 'AuthenticationError' : status === 429 ? 'RateLimitError' : 'APIError');
  process.exit(1);
} else if (exitCode) {
  process.stderr.write(`fake fatal error ${exitCode[1]}\n`);
  process.exit(Number(exitCode[1]));
} else if (scenario === 'text') {
  assistant([{ type: 'thinking', thinking: 'The user wants a greeting.\n', signature: '' }]);
  emit({ type: 'stream_event', uuid: uuid(), parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } });
  assistant([{ type: 'text', text: '\n\n' }]);
  assistant([{ type: 'text', text: 'Hello from fake qwen.' }], { input_tokens: 1200, output_tokens: 34 });
  success('\n\nHello from fake qwen.');
} else if (scenario === 'tool') {
  assistant([{ type: 'tool_use', id: '101', name: 'write_file', input: { file_path: join(process.cwd(), 'hello.txt'), content: 'hi' } }]);
  toolResult('101', 'Successfully created and wrote to new file.');
  assistant([{ type: 'tool_use', id: '102', name: 'run_shell_command', input: { command: 'false' } }]);
  toolResult('102', 'Command exited with code 1', true);
  assistant([{ type: 'text', text: 'done' }]);
  success('done', {}, 3);
} else if (scenario === 'tool-interrupted') {
  assistant([{ type: 'tool_use', id: '201', name: 'read_file', input: { file_path: 'README.md' } }]);
  toolResult('201', '# readme');
  assistant([{ type: 'tool_use', id: '202', name: 'run_shell_command', input: { command: 'make' } }]);
  emit({ type: 'result', subtype: 'error_max_turns', uuid: uuid(), is_error: true, duration_ms: 9, duration_api_ms: 7, num_turns: 2, usage, permission_denials: [], error: { message: 'Reached max session turns' } });
} else if (scenario === 'structured') {
  const value = { answer: 'forty-two', ok: true };
  assistant([{ type: 'tool_use', id: '301', name: 'structured_output', input: value }]);
  success(JSON.stringify(value), { structured_result: value });
} else if (scenario === 'structured-text') {
  assistant([{ type: 'text', text: '```json\n{"answer":"from text","ok":false}\n```' }]);
  success('```json\n{"answer":"from text","ok":false}\n```');
} else if (scenario === 'hang') {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  if (process.env.FAKE_QWEN_PIDFILE) writeFileSync(process.env.FAKE_QWEN_PIDFILE, `${process.pid} ${child.pid}`);
  assistant([{ type: 'tool_use', id: '401', name: 'run_shell_command', input: { command: 'sleep 300' } }]);
  await new Promise(() => {});
} else {
  process.stderr.write(`fake-qwen: unknown scenario ${scenario}\n`);
  process.exit(2);
}
