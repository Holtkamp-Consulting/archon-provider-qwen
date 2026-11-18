import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  buildProviderSubprocessEnv,
  sessionPreview,
  type IAgentProvider,
  type MessageChunk,
  type ProviderCapabilities,
  type ProviderFailure,
  type SendQueryOptions,
} from '@archon/provider-contract';
import type { ProviderLogSink } from '@archon/provider-contract/plugin';
import { capabilities, PROVIDER_ID } from './capabilities';
import { classFromErrorType, classFromExitCode, classFromHttpStatus, EXIT_TURN_LIMIT } from './failure';
import { QwenProcess, type QwenProcessExit } from './process';
import { resolveQwenBinary } from './qwen-binary';
import { QwenStreamMapper } from './stream';
import { toolRestrictionArgs, toolRestrictionsFrom } from './tools';
import { findTranscript, lastApiError } from './transcript';

/** Allowed clock skew between this process and Qwen Code's telemetry timestamps. */
const TELEMETRY_SKEW_MS = 5_000;

function systemPromptText(value: SendQueryOptions['systemPrompt'] | unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    const joined = value.filter((part): part is string => typeof part === 'string').join('\n\n');
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

export function configuredModel(options: SendQueryOptions | undefined): string | undefined {
  if (typeof options?.model === 'string' && options.model.length > 0) return options.model;
  const fromConfig = options?.assistantConfig?.model;
  return typeof fromConfig === 'string' && fromConfig.length > 0 ? fromConfig : undefined;
}

export interface QwenInvocation {
  args: string[];
  freshSessionId?: string;
}

/** The `qwen` arguments for one turn. The prompt travels on stdin, never in argv. */
export function buildArgs(
  resumeSessionId: string | undefined,
  options: SendQueryOptions | undefined,
  newSessionId: () => string = randomUUID
): QwenInvocation {
  const args = [
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--input-format',
    'text',
    // Headless: no one can answer a permission prompt.
    '--approval-mode',
    'yolo',
    // Resume and failure classification read the session transcript.
    '--chat-recording',
  ];
  let freshSessionId: string | undefined;
  if (resumeSessionId !== undefined) {
    args.push('--resume', resumeSessionId);
    if (options?.forkSession === true) args.push('--fork-session');
  } else {
    freshSessionId = newSessionId();
    args.push('--session-id', freshSessionId);
  }
  const model = configuredModel(options);
  if (model !== undefined) args.push('--model', model);
  const systemPrompt =
    systemPromptText(options?.systemPrompt) ?? systemPromptText(options?.nodeConfig?.systemPrompt);
  if (systemPrompt !== undefined) args.push('--system-prompt', systemPrompt);
  else if (options?.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options?.outputFormat?.type === 'json_schema')
    args.push('--json-schema', JSON.stringify(options.outputFormat.schema));
  args.push(...toolRestrictionArgs(toolRestrictionsFrom(options?.nodeConfig)));
  return { args, ...(freshSessionId ? { freshSessionId } : {}) };
}

interface ExitClassification {
  failure?: ProviderFailure;
  errorSubtype?: string;
  stopReason?: 'max_turn_requests';
  sessionNotFound?: boolean;
}

export class QwenProvider implements IAgentProvider {
  private readonly log: ProviderLogSink | undefined;

  constructor(log?: ProviderLogSink) {
    this.log = log;
  }

  getType(): string {
    return PROVIDER_ID;
  }

  getCapabilities(): ProviderCapabilities {
    return capabilities;
  }

  async checkCredential(request: { env: Record<string, string> }): ReturnType<IAgentProvider['checkCredential']> {
    // Qwen Code owns its auth (settings.json modelProviders, env keys, OAuth). Checking it
    // would need a model request, so only a missing CLI is reported.
    const binary = resolveQwenBinary({ ...process.env, ...request.env });
    if (!binary.found) return { state: 'check_failed', source: 'native', evidence: binary.evidence };
    return { state: 'not_checked', source: 'native' };
  }

  async diagnose(request: { signal: AbortSignal }): ReturnType<NonNullable<IAgentProvider['diagnose']>> {
    const binary = resolveQwenBinary(process.env);
    if (!binary.found) {
      return {
        checks: [
          {
            id: 'qwen-cli',
            label: 'Qwen Code CLI',
            status: 'fail',
            message: binary.evidence,
            remedy: 'Install Qwen Code: npm install -g @qwen-code/qwen-code',
          },
        ],
      };
    }
    const version = await new Promise<string | undefined>(resolve => {
      const child = spawn(binary.path, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], signal: request.signal });
      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (data: string) => (out += data));
      child.once('error', () => resolve(undefined));
      child.once('close', code => resolve(code === 0 ? out.trim() : undefined));
    });
    return {
      checks: [
        version
          ? { id: 'qwen-cli', label: 'Qwen Code CLI', status: 'ok', message: `qwen ${version} at ${binary.path}` }
          : {
              id: 'qwen-cli',
              label: 'Qwen Code CLI',
              status: 'warn',
              message: `qwen at ${binary.path} did not report a version`,
            },
      ],
    };
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const env = buildProviderSubprocessEnv(options);
    const binary = resolveQwenBinary(env);
    const signal = options?.abortSignal;
    if (signal?.aborted) return;
    const requestedModel = configuredModel(options);
    const restrictions = toolRestrictionsFrom(options?.nodeConfig);
    const invocation = buildArgs(resumeSessionId, options);
    const mapper = new QwenStreamMapper({
      ...(requestedModel ? { requestedModel } : {}),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      ...(invocation.freshSessionId ? { freshSessionId: invocation.freshSessionId } : {}),
      toolRestrictions: restrictions,
      wantsStructuredOutput: options?.outputFormat?.type === 'json_schema',
    });

    if (!binary.found) {
      await this.log?.({ level: 'error', msg: 'qwen.binary_missing', bindings: { failureClass: 'misconfigured' } });
      yield* mapper.finish({ failure: { class: 'misconfigured', evidence: binary.evidence }, errorSubtype: 'qwen_not_found' });
      yield { type: 'settled' };
      return;
    }

    const startedAt = Date.now();
    const child = new QwenProcess(binary.path, invocation.args, { cwd, env, stdin: prompt });
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let finished = false;
    try {
      for await (const line of child.lines()) {
        for (const chunk of mapper.line(line)) yield chunk;
        if (mapper.fatalCondition) {
          // Stop before Qwen Code spends a model request on a misconfigured turn.
          child.kill();
          break;
        }
      }
      const exit = await child.exit;
      if (cancelled || signal?.aborted) {
        child.killStragglers();
        // Interrupted tool calls close as cancelled; a cancelled turn never settles.
        yield* mapper.closeOpenTools(false);
        finished = true;
        return;
      }
      const classification = await this.classifyExit(exit, mapper, cwd, env, resumeSessionId, startedAt);
      if (classification.failure) {
        await this.log?.({
          level: 'warn',
          msg: 'qwen.turn_failed',
          bindings: { failureClass: classification.failure.class },
        });
      }
      yield* mapper.finish(classification);
      finished = true;
      yield { type: 'settled' };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!finished) {
        // The consumer stopped reading (or the stream threw): do not leave qwen running.
        child.kill();
        await child.exit;
        child.killStragglers();
      }
    }
  }

  private async classifyExit(
    exit: QwenProcessExit,
    mapper: QwenStreamMapper,
    cwd: string,
    env: NodeJS.ProcessEnv,
    resumeSessionId: string | undefined,
    startedAt: number
  ): Promise<ExitClassification> {
    if (mapper.fatalCondition) return {};
    if (exit.spawnError) {
      const code = exit.spawnError.code ?? 'spawn error';
      return {
        failure: {
          class: code === 'ENOENT' || code === 'EACCES' ? 'misconfigured' : 'transient',
          evidence: `could not start qwen (${code}): ${exit.spawnError.message}`,
        },
        errorSubtype: 'qwen_spawn_failed',
      };
    }
    const qwen = mapper.qwenResult;
    if (qwen && qwen.is_error !== true) return {};

    const sessionId = mapper.nativeSessionId ?? resumeSessionId;
    const transcript = sessionId ? await findTranscript(sessionId, cwd, env) : undefined;
    const evidenceTail = exit.stderrTail.length > 0 ? `: ${exit.stderrTail}` : '';

    // A resume Qwen Code rejected before starting: no result line, and no transcript.
    if (!qwen && resumeSessionId !== undefined && mapper.nativeSessionId === undefined && transcript === undefined) {
      return {
        failure: {
          class: 'unknown',
          evidence: `Qwen Code has no session ${sessionPreview(resumeSessionId)} (exit ${String(exit.code)})${evidenceTail}`,
        },
        errorSubtype: 'session_not_found',
        sessionNotFound: true,
      };
    }

    if (exit.code === EXIT_TURN_LIMIT) {
      return { failure: { class: 'unknown', evidence: `qwen exited with code 53 (turn limit)${evidenceTail}` }, stopReason: 'max_turn_requests' };
    }
    const byExit = classFromExitCode(exit.code);
    if (byExit !== 'unknown') {
      return { failure: { class: byExit, evidence: `qwen exited with code ${String(exit.code)}${evidenceTail}` }, errorSubtype: `exit_${String(exit.code)}` };
    }

    const apiError = transcript ? await lastApiError(transcript, startedAt - TELEMETRY_SKEW_MS) : undefined;
    const qwenMessage = typeof qwen?.error?.message === 'string' ? qwen.error.message : undefined;
    if (apiError?.statusCode !== undefined) {
      return {
        failure: {
          class: classFromHttpStatus(apiError.statusCode),
          evidence: `HTTP ${String(apiError.statusCode)}${apiError.errorType ? ` ${apiError.errorType}` : ''}${qwenMessage ? `: ${qwenMessage}` : ''}`,
        },
      };
    }
    if (apiError?.errorType !== undefined) {
      return {
        failure: {
          class: classFromErrorType(apiError.errorType),
          evidence: `${apiError.errorType}${qwenMessage ? `: ${qwenMessage}` : ''}`,
        },
      };
    }
    if (qwen) return { failure: { class: 'unknown', evidence: qwenMessage ?? `qwen reported ${String(qwen.subtype)}` } };
    if (exit.signal) {
      return { failure: { class: 'transient', evidence: `qwen was terminated by ${exit.signal}${evidenceTail}` }, errorSubtype: 'qwen_killed' };
    }
    return {
      failure: { class: 'unknown', evidence: `qwen exited with code ${String(exit.code)} without a result${evidenceTail}` },
      errorSubtype: 'stream_ended_without_result',
    };
  }
}
