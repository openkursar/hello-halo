/**
 * @module core/tool-scheduler
 * Decides which of a turn's tool calls may run together.
 *
 * Scope is one session's one turn. There is no lock, queue or counter shared
 * across sessions: a host running hundreds of them concurrently must not have
 * them serialise against each other.
 * @license MIT
 */

import type { Tool } from '../types/tool.js';
import { getLogger } from '../utils/logger.js';

/**
 * How many concurrency-safe calls run at once. A turn can carry dozens of
 * reads; firing all of them at the same instant buys little over a steady
 * pipeline and can exhaust file handles or trip API rate limits.
 */
export const DEFAULT_MAX_TOOL_CONCURRENCY = 10;

/** Read the concurrency cap, allowing a host to tune it per deployment. */
export function resolveMaxToolConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.HALO_MAX_TOOL_CONCURRENCY ?? '');
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOOL_CONCURRENCY;
}

/** The minimum a scheduled call has to expose: which tool, and its input. */
export interface SchedulableCall {
  name: string;
  input: Record<string, unknown>;
}

/** A run of calls that either all go together, or goes alone. */
export interface ToolBatch<T> {
  concurrencySafe: boolean;
  calls: T[];
}

/**
 * Whether this call can share a batch.
 *
 * A tool that does not answer, answers falsely, or throws while answering is
 * treated as unsafe — the question is about protecting shared state, so an
 * unclear answer has to resolve the same way as "no".
 */
function isConcurrencySafe<T extends SchedulableCall>(call: T, tools: Tool[]): boolean {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool?.isConcurrencySafe) return false;
  try {
    return tool.isConcurrencySafe(call.input) === true;
  } catch (error) {
    getLogger('ToolScheduler').warn('Concurrency check failed; serializing tool call', { tool: call.name, error: String(error) });
    return false;
  }
}

/**
 * Split a turn's calls into batches, preserving the model's ordering.
 *
 * Adjacent safe calls collapse into one batch; every unsafe call gets a batch
 * to itself. Order is preserved so that a write the model placed after a read
 * still happens after it — reordering would change what the model observes.
 */
export function partitionToolCalls<T extends SchedulableCall>(
  calls: T[],
  tools: Tool[],
): Array<ToolBatch<T>> {
  const batches: Array<ToolBatch<T>> = [];
  for (const call of calls) {
    const safe = isConcurrencySafe(call, tools);
    const last = batches[batches.length - 1];
    if (safe && last?.concurrencySafe) {
      last.calls.push(call);
    } else {
      batches.push({ concurrencySafe: safe, calls: [call] });
    }
  }
  return batches;
}

export interface PreparedToolCall<T, R> {
  call: T;
  run: () => Promise<R>;
}

export interface ToolSchedulerOptions<T, R> {
  maxConcurrency?: number;
  signal?: AbortSignal;
  prepare?: (call: T) => Promise<PreparedToolCall<T, R>>;
  /** Preparation is exclusive unless the caller knows it cannot change shared state. */
  canPrepareConcurrently?: boolean;
  /** Called immediately on the first failure, before waiting for active calls. */
  onFailure?: (reason: unknown) => void;
}

export interface ToolScheduler<T, R> {
  enqueue(call: T): void;
  /** Close the producer and wait for every started call to settle. */
  finish(): Promise<R[]>;
  /** Stop queued work; the runner remains responsible for cancelling active calls. */
  stop(reason: unknown): void;
  readonly done: Promise<R[]>;
}

/** Schedules completed calls as they arrive, preserving exclusive-call barriers. */
export function createToolScheduler<T extends SchedulableCall, R>(
  tools: Tool[],
  run: (call: T) => Promise<R>,
  options: ToolSchedulerOptions<T, R> = {},
): ToolScheduler<T, R> {
  const limit = options.maxConcurrency ?? resolveMaxToolConcurrency();
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Tool concurrency must be a positive integer');
  }

  const queue: Array<{ call: T; safe: boolean; index: number; prepared?: PreparedToolCall<T, R> }> = [];
  const results: R[] = [];
  let next = 0;
  let count = 0;
  let active = 0;
  let exclusive = false;
  let closed = false;
  let settled = false;
  let failed = false;
  let failure: unknown;
  let pumping = false;
  let preparing = false;
  let resolve!: (results: R[]) => void;
  let reject!: (reason: unknown) => void;
  const done = new Promise<R[]>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // The producer may still be reading the model stream when execution fails.
  void done.catch(() => {});

  const settle = (): void => {
    if (settled || !closed || active > 0 || preparing || (!failed && next < queue.length)) return;
    settled = true;
    options.signal?.removeEventListener('abort', onAbort);
    if (failed) reject(failure);
    else resolve(results);
  };

  const stop = (reason: unknown): void => {
    if (failed || settled) return;
    failed = true;
    closed = true;
    failure = reason;
    const dropped = queue.length - next;
    if (dropped > 0) {
      getLogger('ToolScheduler').warn('Queued tool calls discarded because execution stopped', {
        queued: dropped,
        running: active,
        aborted: options.signal?.aborted === true,
      });
    }
    queue.length = 0;
    next = 0;
    try { options.onFailure?.(reason); }
    catch {
      getLogger('ToolScheduler').warn('Tool cancellation callback failed; active calls must still settle');
    }
    settle();
  };

  function onAbort(): void {
    stop(options.signal?.reason ?? new DOMException('Tool execution aborted', 'AbortError'));
  }

  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    try {
      while (!failed && !exclusive && !preparing && active < limit && next < queue.length) {
        const entry = queue[next];
        if (options.prepare && !entry.prepared) {
          if (!options.canPrepareConcurrently && active > 0) break;
          preparing = true;
          Promise.resolve().then(() => {
            if (failed) throw failure;
            return options.prepare!(entry.call);
          }).then(prepared => {
            preparing = false;
            if (!failed) {
              entry.prepared = prepared;
              entry.safe = isConcurrencySafe(prepared.call, tools);
            }
            pump();
            settle();
          }, error => {
            preparing = false;
            stop(error);
            settle();
          });
          break;
        }
        if (!entry.safe && active > 0) break;
        next++;
        active++;
        exclusive = !entry.safe;
        const complete = (): void => {
          active--;
          if (!entry.safe) exclusive = false;
          pump();
          settle();
        };
        try {
          Promise.resolve(entry.prepared ? entry.prepared.run() : run(entry.call)).then(
            result => { results[entry.index] = result; complete(); },
            error => { stop(error); complete(); },
          );
        } catch (error) {
          stop(error);
          complete();
        }
      }
      // Release completed call inputs without repeatedly shifting a large queue.
      if (next === queue.length) {
        queue.length = 0;
        next = 0;
      }
    } finally {
      pumping = false;
    }
    settle();
  };

  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  return {
    enqueue(call) {
      if (failed) throw failure;
      if (closed) throw new Error('Tool scheduler is closed');
      queue.push({ call, safe: options.prepare ? false : isConcurrencySafe(call, tools), index: count++ });
      pump();
    },
    finish() {
      closed = true;
      settle();
      return done;
    },
    stop,
    done,
  };
}

/** Execute a complete batch through the same scheduler used by streaming turns. */
export async function runToolBatches<T extends SchedulableCall, R>(
  calls: T[],
  tools: Tool[],
  run: (call: T) => Promise<R>,
  maxConcurrency: number = resolveMaxToolConcurrency(),
): Promise<R[]> {
  const scheduler = createToolScheduler(tools, run, { maxConcurrency });
  try {
    for (const call of calls) scheduler.enqueue(call);
  } catch (error) {
    scheduler.stop(error);
  }
  return scheduler.finish();
}
