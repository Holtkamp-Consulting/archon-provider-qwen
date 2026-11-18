import {
  sessionPreview,
  truncateToolOutput,
  type ProviderChunk,
  type ProviderFailure,
  type TokenUsage,
} from '@archon/provider-contract';
import { STRUCTURED_OUTPUT_TOOL, toolRestrictionViolation, type ToolRestrictions } from './tools';
import { parseStructuredText } from './structured';

type ResultChunk = Extract<ProviderChunk, { type: 'result' }>;

/** Minimum gap between heartbeats derived from Qwen Code's partial-message stream. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

export interface MapperOptions {
  /** Model Archon asked for; the turn fails as misconfigured if Qwen Code selects another. */
  requestedModel?: string;
  resumeSessionId?: string;
  /** Session id passed with `--session-id` for a fresh session. */
  freshSessionId?: string;
  toolRestrictions: ToolRestrictions;
  wantsStructuredOutput: boolean;
  now?: () => number;
}

/** A condition the mapper detected that must stop the qwen process before more work. */
export interface FatalCondition {
  failure: ProviderFailure;
  errorSubtype: string;
}

interface QwenResult {
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_result?: unknown;
  num_turns?: unknown;
  usage?: Record<string, unknown>;
  error?: { message?: unknown };
  session_id?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function tokensFromUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  const input = finiteNumber(usage?.input_tokens);
  const output = finiteNumber(usage?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const tokens: TokenUsage = { input, output };
  const cacheRead = finiteNumber(usage?.cache_read_input_tokens);
  const cacheWrite = finiteNumber(usage?.cache_creation_input_tokens);
  const total = finiteNumber(usage?.total_tokens);
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
  if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
  if (total !== undefined) tokens.total = total;
  return tokens;
}

function toolOutputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        const entry = record(block);
        if (entry?.type === 'text' && typeof entry.text === 'string') return entry.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Drop values JSON cannot carry (undefined, functions) by round-tripping. */
function toJson(value: unknown): Json {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

/**
 * Translates Qwen Code `--output-format stream-json` lines into Archon provider chunks.
 * Pure: the process owner feeds lines and the exit, and decides when to kill.
 */
export class QwenStreamMapper {
  private readonly options: MapperOptions;
  private readonly now: () => number;
  private pendingText = '';
  private textBlockOpen = false;
  private readonly openTools = new Map<string, string>();
  private readonly usedToolIds = new Set<string>();
  private readonly structuredToolIds = new Set<string>();
  private lastHeartbeat = 0;
  private result: QwenResult | undefined;
  private sessionId: string | undefined;
  private reportedModel: string | undefined;
  private fatal: FatalCondition | undefined;

  constructor(options: MapperOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.lastHeartbeat = this.now();
  }

  get fatalCondition(): FatalCondition | undefined {
    return this.fatal;
  }

  get sawResult(): boolean {
    return this.result !== undefined;
  }

  get nativeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Feed one stdout line. Returns the chunks it produces. */
  line(text: string): ProviderChunk[] {
    if (this.fatal || this.result) return [];
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return [];
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(trimmed));
    } catch {
      return [];
    }
    if (!message) return [];
    if (typeof message.session_id === 'string' && message.session_id.length > 0 && !this.sessionId)
      this.sessionId = message.session_id;
    switch (message.type) {
      case 'system':
        return this.system(message);
      case 'stream_event':
        return this.heartbeat();
      case 'assistant':
        return message.parent_tool_use_id ? this.heartbeat() : this.assistant(message);
      case 'user':
        return message.parent_tool_use_id ? this.heartbeat() : this.user(message);
      case 'result':
        this.result = message as QwenResult;
        if (typeof message.session_id === 'string' && message.session_id.length > 0)
          this.sessionId = message.session_id;
        return [];
      default:
        return [];
    }
  }

  private heartbeat(): ProviderChunk[] {
    const now = this.now();
    if (now - this.lastHeartbeat < HEARTBEAT_INTERVAL_MS) return [];
    this.lastHeartbeat = now;
    return [{ type: 'heartbeat' }];
  }

  private system(message: Record<string, unknown>): ProviderChunk[] {
    if (message.subtype === 'init') {
      if (typeof message.model === 'string') this.reportedModel = message.model;
      const requested = this.options.requestedModel;
      if (requested !== undefined && message.model !== requested) {
        this.fatal = {
          errorSubtype: 'model_not_selected',
          failure: {
            class: 'misconfigured',
            evidence: `Qwen Code selected model ${JSON.stringify(message.model ?? null)} instead of the requested ${JSON.stringify(requested)}; the model is not configured in Qwen Code (modelProviders in ~/.qwen/settings.json)`,
          },
        };
        return [];
      }
      if (Array.isArray(message.tools)) {
        const tools = message.tools.filter((tool): tool is string => typeof tool === 'string');
        const violation = toolRestrictionViolation(this.options.toolRestrictions, tools);
        if (violation) {
          this.fatal = {
            errorSubtype: 'tool_restrictions_not_enforced',
            failure: { class: 'misconfigured', evidence: `Qwen Code started with ${violation}` },
          };
        }
      }
      return [];
    }
    const meta = record(message.compact_metadata);
    if (meta && (meta.trigger === 'manual' || meta.trigger === 'auto')) {
      const chunk: ProviderChunk = { type: 'compaction', phase: 'completed', trigger: meta.trigger };
      const before = finiteNumber(meta.pre_tokens);
      if (before !== undefined && Number.isInteger(before) && before >= 0) chunk.tokensBefore = before;
      return [chunk];
    }
    return [];
  }

  private flushText(): ProviderChunk[] {
    const text = this.pendingText.trim();
    this.pendingText = '';
    if (text.length === 0) return [];
    this.textBlockOpen = false;
    return [{ type: 'agent_message_chunk', text }];
  }

  private assistant(message: Record<string, unknown>): ProviderChunk[] {
    const content = record(message.message)?.content;
    if (!Array.isArray(content)) return [];
    const chunks: ProviderChunk[] = [];
    for (const raw of content) {
      const block = record(raw);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        this.pendingText += block.text;
        this.textBlockOpen = true;
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        chunks.push(...this.flushText());
        const thought = block.thinking.trim();
        if (thought.length > 0) chunks.push({ type: 'agent_thought_chunk', text: thought });
      } else if (block.type === 'tool_use') {
        chunks.push(...this.flushText());
        chunks.push(this.startTool(block));
      }
    }
    return chunks;
  }

  private startTool(block: Record<string, unknown>): ProviderChunk {
    const name = typeof block.name === 'string' ? block.name : 'unknown';
    const nativeId = typeof block.id === 'string' && block.id.length > 0 ? block.id : `qwen-tool-${String(this.usedToolIds.size + 1)}`;
    let id = nativeId;
    for (let n = 2; this.usedToolIds.has(id); n++) id = `${nativeId}#${String(n)}`;
    this.usedToolIds.add(id);
    if (name === STRUCTURED_OUTPUT_TOOL) this.structuredToolIds.add(id);
    // Results reference the native id; the newest call with that id owns it.
    this.openTools.set(nativeId, id);
    return { type: 'tool_call', toolCallId: id, name, rawInput: toJson(block.input) };
  }

  private user(message: Record<string, unknown>): ProviderChunk[] {
    const content = record(message.message)?.content;
    if (!Array.isArray(content)) return [];
    const chunks: ProviderChunk[] = [];
    for (const raw of content) {
      const block = record(raw);
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const id = this.openTools.get(block.tool_use_id);
      if (id === undefined) continue;
      this.openTools.delete(block.tool_use_id);
      chunks.push({
        type: 'tool_call_update',
        toolCallId: id,
        status: block.is_error === true ? 'failed' : 'completed',
        ...truncateToolOutput(toolOutputText(block.content)),
      });
    }
    return chunks;
  }

  /**
   * Close every open tool call: at the end of a turn (a call Qwen Code never answered was
   * interrupted) and on cancellation. The synthetic `structured_output` call completes when
   * Qwen Code accepted its payload, since the session ends on it without a tool result.
   */
  closeOpenTools(structuredOutputAccepted: boolean): ProviderChunk[] {
    const chunks: ProviderChunk[] = [];
    for (const id of this.openTools.values()) {
      const completed = structuredOutputAccepted && this.structuredToolIds.has(id);
      chunks.push({ type: 'tool_call_update', toolCallId: id, status: completed ? 'completed' : 'cancelled' });
    }
    this.openTools.clear();
    return chunks;
  }

  /**
   * End of the turn, after the process exited. Produces the closing tool updates and the
   * `result`; the caller appends `settled`.
   */
  finish(exit: {
    failure?: ProviderFailure;
    errorSubtype?: string;
    stopReason?: ResultChunk['stopReason'];
    sessionNotFound?: boolean;
  }): ProviderChunk[] {
    const qwen = this.result;
    const failure = this.fatal?.failure ?? exit.failure;
    const chunks: ProviderChunk[] = [];
    const result: ResultChunk = { type: 'result' };
    const sessionId = this.sessionId ?? this.options.freshSessionId;
    const failed = failure !== undefined || qwen === undefined || qwen.is_error === true;

    let structured: unknown;
    if (!failed && this.options.wantsStructuredOutput && qwen) {
      if ('structured_result' in qwen && qwen.structured_result !== null && qwen.structured_result !== undefined)
        structured = qwen.structured_result;
      else if (typeof qwen.result === 'string') structured = parseStructuredText(qwen.result);
    }

    if (failed) this.pendingText = '';
    chunks.push(...this.flushText());
    chunks.push(...this.closeOpenTools(structured !== undefined));

    if (sessionId !== undefined && !(failed && exit.sessionNotFound)) result.sessionId = sessionId;
    if (qwen && typeof qwen.result === 'string' && !failed) result.text = qwen.result.trim();
    const tokens = tokensFromUsage(qwen?.usage);
    if (tokens) result.tokens = tokens;
    const turns = finiteNumber(qwen?.num_turns);
    if (turns !== undefined) result.numTurns = turns;
    if (this.reportedModel) result.resolvedModel = { id: this.reportedModel };
    if (this.options.resumeSessionId !== undefined) {
      result.resumed = exit.sessionNotFound ? false : this.sessionId !== undefined;
    }
    if (structured !== undefined) result.structuredOutput = structured;

    if (failed) {
      const evidence =
        failure?.evidence ??
        (typeof qwen?.error?.message === 'string' && qwen.error.message.length > 0
          ? qwen.error.message
          : `Qwen Code ended the turn with ${String(qwen?.subtype ?? 'no result')}`);
      result.isError = true;
      result.failure = { ...(failure ?? { class: 'unknown' }), evidence };
      result.errorSubtype = this.fatal?.errorSubtype ?? exit.errorSubtype ?? (typeof qwen?.subtype === 'string' ? qwen.subtype : 'qwen_failed');
      result.errors = [evidence];
      if (exit.sessionNotFound) result.sessionNotFound = true;
    }
    if (qwen?.subtype === 'error_max_turns') result.stopReason = 'max_turn_requests';
    else if (exit.stopReason) result.stopReason = exit.stopReason;
    else if (!failed) result.stopReason = 'end_turn';
    chunks.push(result);
    return chunks;
  }

  /** Failure classification inputs the caller needs once the process has exited. */
  get qwenResult(): QwenResult | undefined {
    return this.result;
  }

  sessionPreview(): string | undefined {
    return this.sessionId ? sessionPreview(this.sessionId) : undefined;
  }
}
