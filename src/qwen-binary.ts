import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Environment variable that points the provider at a specific `qwen` executable. */
export const QWEN_PATH_ENV = 'ARCHON_QWEN_PATH';

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type QwenBinary = { found: true; path: string } | { found: false; evidence: string };

/** `ARCHON_QWEN_PATH`, else `qwen` on PATH. */
export function resolveQwenBinary(env: Record<string, string | undefined>): QwenBinary {
  const override = env[QWEN_PATH_ENV];
  if (override !== undefined && override.length > 0) {
    if (isAbsolute(override) && executable(override)) return { found: true, path: override };
    return {
      found: false,
      evidence: `${QWEN_PATH_ENV}=${override} is not an executable file (absolute path required)`,
    };
  }
  const names = process.platform === 'win32' ? ['qwen.cmd', 'qwen.exe', 'qwen'] : ['qwen'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (executable(path)) return { found: true, path };
    }
  }
  return {
    found: false,
    evidence: `Qwen Code CLI (qwen) not found on PATH; install it (npm i -g @qwen-code/qwen-code) or set ${QWEN_PATH_ENV}`,
  };
}
