/**
 * @module tools/bash/background
 * Session-owned shell processes with file-backed output.
 * @license MIT
 */

import { spawn } from '../../utils/processes.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { MAX_BACKGROUND_OUTPUT_BYTES, pruneOutput } from './output-retention.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellState } from '../../types/tool.js';
import { getLogger } from '../../utils/logger.js';
import { prepareShellCommand, resolveShellPath, shellEnvironment } from './provider.js';
import { killTree } from './tree-kill.js';
import { resolveWorkingDirectory } from './working-directory.js';

const log = getLogger('BackgroundBash');
const MAX_RUNNING_TASKS = 32;
const MAX_COMPLETED_TASKS = 128;
const OUTPUT_PREVIEW_BYTES = 32 * 1024;

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface BackgroundTask {
  id: string;
  command: string;
  status: BackgroundTaskStatus;
  outputFile: string;
  outputTruncated?: boolean;
  cwdWarning?: string;
  exitCode: number | null;
  error: string | null;
  pid: number | undefined;
  startedAt: number;
  completedAt: number | null;
  done: Promise<void>;
}

interface RunningTask {
  task: BackgroundTask;
  stop: (reason: string, status: 'stopped' | 'failed') => void;
}

export interface BackgroundTaskOptions {
  /** Persistent session directory; absent means temporary output, removed on dispose. */
  outputDir?: string | (() => string);
  onNotice?: (notice: string) => void;
}

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly running = new Map<string, RunningTask>();
  private directory: Promise<string> | undefined;
  private disposed = false;
  private closing: Promise<void> = Promise.resolve();
  private starting = 0;

  constructor(private readonly options: BackgroundTaskOptions = {}) {}

  get activeCount(): number { return this.running.size + this.starting; }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  getAll(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  async start(options: {
    command: string;
    state: ShellState;
    fallbackCwd?: string;
    env: Record<string, string | undefined>;
    /** Optional execution deadline; otherwise the session owns the lifetime. */
    timeoutMs?: number;
    /** Launch cancellation only; the owner stops running tasks through stopAll or dispose. */
    abortSignal: AbortSignal;
  }): Promise<BackgroundTask> {
    if (this.disposed) throw new Error('Background task registry is closed');
    if (options.abortSignal.aborted) throw new Error('Command cancelled before launch');
    if (this.running.size + this.starting >= MAX_RUNNING_TASKS) {
      throw new Error(`At most ${MAX_RUNNING_TASKS} background commands may run in one session`);
    }
    this.starting++;
    let releaseStart!: () => void;
    const starting = new Promise<void>(resolve => { releaseStart = resolve; });
    const previous = this.closing;
    this.closing = Promise.all([previous, starting]).then(() => {});
    try {
      const state = { cwd: options.state.cwd, envVars: new Map(options.state.envVars) };
      const resolved = await resolveWorkingDirectory(state.cwd, options.fallbackCwd);
      state.cwd = resolved.cwd;
      const shellPath = resolveShellPath(options.env);
      const outputDir = typeof this.options.outputDir === 'function' ? this.options.outputDir() : this.options.outputDir;
      this.directory ??= outputDir
        ? fs.mkdir(outputDir, { recursive: true, mode: 0o700 }).then(() => outputDir)
        : fs.mkdtemp(join(tmpdir(), 'agent-bash-'));
      const directory = await this.directory;
      if (this.options.outputDir) await pruneOutput(directory);
      const id = `bash-${randomUUID()}`;
      const outputFile = join(directory, `${id}.output`);
      const output = await fs.open(outputFile, 'wx', 0o600);
      let ownsOutput = true;
      try {
        if (this.disposed || options.abortSignal.aborted) {
          throw new Error('Command cancelled before launch');
        }
        const launch = prepareShellCommand(shellPath, options.command, state, id);
        let resolveDone!: () => void;
        const task: BackgroundTask = {
          id, command: options.command.slice(0, 4096), status: 'running', outputFile,
          cwdWarning: resolved.warning,
          exitCode: null, error: null, pid: undefined,
          startedAt: Date.now(), completedAt: null,
          done: new Promise<void>(resolve => { resolveDone = resolve; }),
        };
        this.tasks.set(id, task);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let child: ReturnType<typeof spawn> | undefined;
        const stop = (reason: string, status: 'stopped' | 'failed'): void => {
          if (settled || task.status !== 'running') return;
          task.status = status;
          task.error = reason;
          clearTimeout(timer);
          if (status === 'failed') log.warn('background command timed out', { taskId: id, timeoutMs: options.timeoutMs });
          // Descendants may ignore TERM or keep output pipes open; stop the whole group.
          if (child?.pid) killTree(child.pid, 'SIGKILL');
        };
        let writtenBytes = 0;
        const marker = Buffer.from('\n[Output truncated at 8 MiB. Re-run with filters or redirect to your own file.]\n');
        const writer = new Writable({
          highWaterMark: 64 * 1024,
          write(chunk: Buffer, _encoding, callback) {
            const remaining = MAX_BACKGROUND_OUTPUT_BYTES - marker.length - writtenBytes;
            const bytes = chunk.subarray(0, Math.max(0, remaining));
            const truncating = bytes.length < chunk.length && !task.outputTruncated;
            task.outputTruncated ||= bytes.length < chunk.length;
            writtenBytes += bytes.length;
            const write = async (): Promise<void> => {
              if (bytes.length) await output.writeFile(bytes);
              if (truncating) {
                await output.writeFile(marker);
                log.warn('background command output truncated', { taskId: id, limitBytes: MAX_BACKGROUND_OUTPUT_BYTES });
              }
            };
            write().then(() => callback(), error => callback(error));
          },
        });
        const drained = finished(writer, { cleanup: true }).catch(error => {
          log.warn('background command output write failed', { taskId: id, error: String(error) });
          task.status = 'failed';
          task.error = 'Output persistence failed';
          if (child?.pid) killTree(child.pid, 'SIGKILL');
          child?.stdout?.destroy();
          child?.stderr?.destroy();
        });
        ownsOutput = false;
        const finish = async (exitCode: number | null): Promise<void> => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          writer.end();
          await drained;
          try {
            await output.close();
            if (this.options.outputDir) {
              await fs.writeFile(`${outputFile}.done`, '', { mode: 0o600 });
              await fs.rm(`${outputFile}.active-${task.pid ?? process.pid}`, { force: true });
              await pruneOutput(directory);
            }
          } catch (error) {
            task.status = 'failed';
            task.error = 'Output finalization failed';
            log.warn('background output finalization failed', { taskId: id, error: String(error) });
          }
          launch.cleanup();
          task.exitCode = exitCode;
          if (task.status === 'running') task.status = exitCode === 0 ? 'completed' : 'failed';
          task.completedAt = Date.now();
          this.running.delete(id);
          if (!this.disposed) {
            try {
              this.options.onNotice?.(
                `Background Bash task ${id} ${task.status}${task.error ? `: ${task.error}` : ''}. ` +
                `${task.outputTruncated ? 'Output was truncated at 8 MiB. ' : ''}Output file: ${outputFile}. Use Read for output or TaskOutput with task_id "${id}" for status.`,
              );
            } catch (error) {
              log.warn('background completion notice failed', { taskId: id, error: String(error) });
            }
            this.pruneCompleted();
          }
          resolveDone();
        };
        this.running.set(id, { task, stop });
        try {
          child = spawn(launch.executable, launch.args, {
            ...launch.options,
            env: shellEnvironment(options.env),
          });
          task.pid = child.pid;
          child.stdout?.pipe(writer, { end: false });
          child.stderr?.pipe(writer, { end: false });
          if (options.timeoutMs !== undefined) {
            timer = setTimeout(() => stop(`Timed out after ${options.timeoutMs}ms`, 'failed'), options.timeoutMs);
            timer.unref();
          }
          child.once('error', err => {
            task.status = 'failed';
            task.error = err.message;
            log.warn('background command failed to spawn', { taskId: id, error: err.message });
          });
          child.once('close', code => { void finish(code); });
          child.unref();
          if (this.options.outputDir && task.pid) {
            await fs.writeFile(`${outputFile}.active-${task.pid}`, '', { mode: 0o600 });
            if (settled) await fs.rm(`${outputFile}.active-${task.pid}`, { force: true });
          }
        } catch (error) {
          task.status = 'failed';
          task.error = error instanceof Error ? error.message : String(error);
          log.warn('background command failed to spawn', { taskId: id, error: task.error });
          if (child?.pid) killTree(child.pid, 'SIGKILL');
          await finish(null);
        }
        return task;
      } finally {
        if (ownsOutput) await output.close();
      }
    } finally {
      this.starting--;
      releaseStart();
    }
  }

  stop(id: string): boolean {
    const entry = this.running.get(id);
    if (!entry || entry.task.status !== 'running') return false;
    entry.stop('Stopped by request', 'stopped');
    return true;
  }

  stopAll(): void {
    for (const entry of this.running.values()) entry.stop('Session interrupted', 'stopped');
  }

  async readOutput(task: BackgroundTask): Promise<{ output: string; truncated: boolean }> {
    let file;
    try { file = await fs.open(task.outputFile, 'r'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      log.warn('command output is no longer retained', { taskId: task.id });
      return { output: '[Command output is no longer available. It may have expired under the retention policy or been removed. Task status is unchanged.]', truncated: true };
    }
    try {
      const buffer = Buffer.alloc(OUTPUT_PREVIEW_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return {
        output: buffer.subarray(0, Math.min(bytesRead, OUTPUT_PREVIEW_BYTES)).toString('utf8'),
        truncated: !!task.outputTruncated || bytesRead > OUTPUT_PREVIEW_BYTES,
      };
    } finally {
      await file.close();
    }
  }

  private pruneCompleted(): void {
    let completed = this.tasks.size - this.running.size;
    for (const [id] of this.tasks) {
      if (completed <= MAX_COMPLETED_TASKS) break;
      if (!this.running.has(id)) {
        this.tasks.delete(id);
        completed--;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = [...this.running.values()];
    for (const entry of pending) entry.stop('Session closed', 'stopped');
    this.tasks.clear();
    this.closing = Promise.all([this.closing, ...pending.map(entry => entry.task.done)]).then(async () => {
      if (!this.options.outputDir && this.directory) {
        await fs.rm(await this.directory, { recursive: true, force: true });
      }
    }).catch(error => {
      log.warn('background task cleanup failed', { error: String(error) });
    });
  }

  /** Wait for shutdown cleanup; does not wait for active tasks in an open session. */
  async flush(): Promise<void> {
    await this.closing;
  }
}
