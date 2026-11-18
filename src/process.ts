import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** How long a process group gets after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_CHARS = 2_000;

export interface QwenProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all. */
  spawnError?: NodeJS.ErrnoException;
  stderrTail: string;
}

/**
 * One `qwen` run in its own process group, so cancellation reaches every descendant
 * (shell tools, sub-agents) that did not detach itself into a new session.
 */
export class QwenProcess {
  private readonly child: ChildProcess;
  private stderr = '';
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private exited = false;
  readonly exit: Promise<QwenProcessExit>;

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string }) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.exit = new Promise<QwenProcessExit>(resolve => {
      let spawnError: NodeJS.ErrnoException | undefined;
      this.child.once('error', error => {
        spawnError = error as NodeJS.ErrnoException;
        // A failed spawn emits no 'close' on some runtimes.
        if (this.child.pid === undefined) {
          this.exited = true;
          resolve({ code: null, signal: null, spawnError, stderrTail: '' });
        }
      });
      this.child.once('close', (code, signal) => {
        this.exited = true;
        if (this.killTimer) clearTimeout(this.killTimer);
        resolve({ code, signal, ...(spawnError ? { spawnError } : {}), stderrTail: this.stderr.trim() });
      });
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (data: string) => {
      this.stderr = (this.stderr + data).slice(-STDERR_TAIL_CHARS);
    });
    this.child.stdin?.on('error', () => {
      // The process may exit before reading its prompt; the exit reports why.
    });
    this.child.stdin?.end(options.stdin);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  lines(): AsyncIterable<string> {
    if (!this.child.stdout) return (async function* () {})();
    return createInterface({ input: this.child.stdout, crlfDelay: Infinity });
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  }

  /** SIGTERM the whole process group, then SIGKILL it if it is still alive after the grace period. */
  kill(): void {
    if (this.exited || this.killTimer) return;
    this.signalGroup('SIGTERM');
    this.killTimer = setTimeout(() => this.signalGroup('SIGKILL'), KILL_GRACE_MS);
    this.killTimer.unref?.();
  }

  /** After a normal exit, reap any process still left in the group. */
  killStragglers(): void {
    this.signalGroup('SIGKILL');
  }
}
