import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderChunk, SendQueryOptions } from '@archon/provider-contract';

export const FAKE_QWEN = join(import.meta.dir, 'fixtures', 'fake-qwen.sh');

export interface Sandbox {
  root: string;
  cwd: string;
  qwenHome: string;
  /** Environment that points the provider at the fake qwen. */
  env: Record<string, string>;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-provider-qwen-')));
  const cwd = join(root, 'repo');
  const qwenHome = join(root, 'qwen-home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(qwenHome, { recursive: true });
  return {
    root,
    cwd,
    qwenHome,
    env: {
      ARCHON_QWEN_PATH: FAKE_QWEN,
      QWEN_HOME: qwenHome,
      FAKE_QWEN_BUN: process.execPath,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const prompt = (scenario: string, text = 'do the thing'): string => `scenario:${scenario}\n${text}`;

export function withEnv(box: Sandbox, options: SendQueryOptions = {}): SendQueryOptions {
  return { ...options, env: { ...box.env, ...options.env } };
}

export async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  return Array.fromAsync(stream);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
