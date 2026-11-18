import type { ProviderFailureClass } from '@archon/provider-contract';

/**
 * Failure classes from Qwen Code's structured signals only: the HTTP status and error
 * class it records in its session transcript (`qwen-code.api_error`), and the exit codes
 * of its FatalError subclasses. Error prose is kept as evidence and never inspected.
 */
export function classFromHttpStatus(status: number): ProviderFailureClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota_exhausted';
  if (status === 404) return 'misconfigured';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  if (status === 408 || status === 409 || status === 425 || status >= 500) return 'transient';
  return 'unknown';
}

/** OpenAI SDK error classes that mean the request never got an HTTP answer. */
const CONNECTION_ERROR_TYPES = new Set(['APIConnectionError', 'APIConnectionTimeoutError']);

export function classFromErrorType(errorType: string | undefined): ProviderFailureClass {
  return errorType !== undefined && CONNECTION_ERROR_TYPES.has(errorType) ? 'transient' : 'unknown';
}

/**
 * Exit codes of Qwen Code's FatalError subclasses (0.24.x):
 * 42 input, 44 sandbox, 52 config, 53 turn limit, 55 budget / wall time / tool-call cap,
 * 130 cancellation.
 */
export function classFromExitCode(code: number | null): ProviderFailureClass {
  if (code === 42 || code === 44 || code === 52) return 'misconfigured';
  if (code === 55) return 'budget_exceeded';
  return 'unknown';
}

export const EXIT_TURN_LIMIT = 53;
