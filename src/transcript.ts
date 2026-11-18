import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Qwen Code records every session as JSONL under
 * `<runtime dir>/projects/<sanitized project root>/chats/<session id>.jsonl`. The runtime
 * dir is `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else `~/.qwen`. The provider reads it for
 * two structured facts the stream-json output does not carry: whether a session exists
 * (resume), and the HTTP status of a failed API call.
 */
function runtimeDirs(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || homedir();
  const expand = (dir: string): string =>
    dir.startsWith('~/') ? join(home, dir.slice(2)) : isAbsolute(dir) ? dir : resolve(dir);
  const dirs = [env.QWEN_RUNTIME_DIR, env.QWEN_HOME].filter(
    (dir): dir is string => typeof dir === 'string' && dir.length > 0
  );
  return [...new Set([...dirs.map(expand), join(home, '.qwen')])];
}

function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const SESSION_ID = /^[A-Za-z0-9-]+$/;

/** The transcript file of a session, or undefined when no runtime dir holds one. */
export async function findTranscript(
  sessionId: string,
  cwd: string,
  env: Record<string, string | undefined>
): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const file = `${sessionId}.jsonl`;
  let real = cwd;
  try {
    real = await realpath(cwd);
  } catch {
    // Keep the given path.
  }
  for (const dir of runtimeDirs(env)) {
    for (const candidate of new Set([sanitizeCwd(real), sanitizeCwd(cwd)])) {
      const path = join(dir, 'projects', candidate, 'chats', file);
      if (await isFile(path)) return path;
    }
    // The project root can be an ancestor of cwd (for example the git root).
    let projects: string[];
    try {
      projects = await readdir(join(dir, 'projects'));
    } catch {
      continue;
    }
    for (const project of projects) {
      const path = join(dir, 'projects', project, 'chats', file);
      if (await isFile(path)) return path;
    }
  }
  return undefined;
}

export interface RecordedApiError {
  statusCode?: number;
  errorType?: string;
}

/**
 * The last `qwen-code.api_error` telemetry record the session wrote at or after `since`
 * (epoch ms). Only typed fields are read: `status_code` and `error_type`.
 */
export async function lastApiError(path: string, since: number): Promise<RecordedApiError | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let found: RecordedApiError | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('qwen-code.api_error')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const event = (record as { systemPayload?: { uiEvent?: Record<string, unknown> } })
      ?.systemPayload?.uiEvent;
    if (!event || event['event.name'] !== 'qwen-code.api_error') continue;
    const at = Date.parse(String(event['event.timestamp'] ?? ''));
    if (Number.isFinite(at) && at < since) continue;
    const entry: RecordedApiError = {};
    if (typeof event.status_code === 'number' && Number.isInteger(event.status_code))
      entry.statusCode = event.status_code;
    if (typeof event.error_type === 'string' && event.error_type.length > 0)
      entry.errorType = event.error_type;
    found = entry;
  }
  return found;
}
