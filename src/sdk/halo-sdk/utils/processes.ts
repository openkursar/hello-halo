import { spawn as nodeSpawn, execFile as nodeExecFile, type ChildProcess } from 'node:child_process';
import { getLogger } from './logger.js';
import { processTreeContext, killWindowsProcessTree, type ProcessTreeContext } from './windows-process-tree.js';
export type { ProcessTreeContext } from './windows-process-tree.js';

const contexts = new Map<number, ProcessTreeContext>();
const terminations = new Map<number, Promise<void>>();
const ownedProcesses = new Map<number, { signal?: KillSignal; exited: boolean }>();
export function getProcessTreeContext(child: ChildProcess): ProcessTreeContext | undefined {
  return child.pid ? contexts.get(child.pid) : undefined;
}

function observe(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid) {
    const pid = child.pid;
    const owned: { signal?: KillSignal; exited: boolean } = { exited: false };
    ownedProcesses.set(pid, owned);
    const repeatStop = () => {
      if (ownedProcesses.get(pid) === owned && owned.signal) void killProcessTree(pid, owned.signal);
    };
    child.once('spawn', repeatStop);
    child.once('exit', () => { owned.exited = true; repeatStop(); });
    child.once('close', () => { if (ownedProcesses.get(pid) === owned) ownedProcesses.delete(pid); });
  }
  const context = processTreeContext(child.spawnfile);
  if (context && child.pid) {
    const pid = child.pid;
    contexts.set(pid, context);
    child.once('close', () => contexts.delete(pid));
  }
  observer?.(child);
}

let observer: ((child: ChildProcess) => void) | undefined;

/** Execution runtimes can supervise SDK-owned children without changing tool semantics. */
export function setChildProcessObserver(next: (child: ChildProcess) => void): void { observer = next; }

export const spawn: typeof nodeSpawn = ((...args: any[]): ChildProcess => {
  const child = (nodeSpawn as (...args: any[]) => ChildProcess)(...args);
  observe(child);
  return child;
}) as typeof nodeSpawn;

export const execFile: typeof nodeExecFile = ((...args: any[]): ChildProcess => {
  const child = (nodeExecFile as (...args: any[]) => ChildProcess)(...args);
  observe(child);
  return child;
}) as typeof nodeExecFile;

export type KillSignal = 'SIGTERM' | 'SIGKILL';

/** POSIX children must start detached to give the SDK ownership of their whole process group. */
export function killProcessTree(pid: number, signal: KillSignal = 'SIGTERM', context = contexts.get(pid)): Promise<void> {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    const pending = terminations.get(pid);
    if (pending) return pending;
    const done = killWindowsProcessTree(pid, context).finally(() => terminations.delete(pid));
    terminations.set(pid, done);
    return done;
  }
  // Group setup and fork can race a stop. Spawn/exit callbacks repeat it while this owner remains open.
  const owned = ownedProcesses.get(pid);
  if (owned && owned.signal !== 'SIGKILL') owned.signal = signal;
  try { process.kill(-pid, signal); }
  catch (error) {
    if (owned?.exited) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') getLogger('Processes').warn('Process group termination failed after parent exit', { pid, error: String(error) });
      return Promise.resolve();
    }
    try { process.kill(pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') getLogger('Processes').warn('Process termination failed', { pid, error: String(error) });
    }
  }
  return Promise.resolve();
}
