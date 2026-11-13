import { loadBinding } from './binding.js';
import { createCollaborationCallbacks } from './collaboration-callbacks.js';
import { collaborationValue } from './collaboration-values.js';
import type { BusyDisposition, DeliverDisposition, TurnGate, TurnGateHooks, TurnGateOptions } from '../collaboration/turn-gate.js';

export type { BusyDisposition, DeliverDisposition, TurnGate, TurnGateHooks, TurnGateOptions } from '../collaboration/turn-gate.js';
export class TurnGateCapacityError extends Error {
  constructor(sessionKey: string) {
    super(collaborationValue('errorText', { kind: 'mailbox', name: sessionKey }));
    this.name = 'TurnGateCapacityError';
  }
}

export function createTurnGate<TJob>(hooks: TurnGateHooks<TJob>, options: TurnGateOptions<TJob> = {}): TurnGate<TJob> {
  let nextReference = 0;
  const jobs = new Map<number, { value: TJob; owners: number }>();
  const runs = new Map<number, () => Promise<unknown>>();
  const results = new Map<number, unknown>();
  let predicate: ((key: string, job?: TJob) => boolean) | undefined;
  const retain = (value: TJob): number => { const id = ++nextReference; jobs.set(id, { value, owners: 0 }); return id; };
  const job = (id: number): TJob => {
    const entry = jobs.get(id);
    if (!entry) throw new Error('The native collaboration job reference is unavailable.');
    return entry.value;
  };
  const cleanup = (id: number): void => { if (jobs.get(id)?.owners === 0) jobs.delete(id); };
  const callbacks = createCollaborationCallbacks((name, input) => {
    switch (name) {
      case 'retainJob': jobs.get(input.job)!.owners++; return;
      case 'releaseJob': { const entry = jobs.get(input.job); if (entry) { entry.owners--; cleanup(input.job); } return; }
      case 'isBusy': return hooks.isBusy(input.key);
      case 'getJobIdentity': return hooks.getJobIdentity?.(job(input.job));
      case 'getActiveIdentity': return hooks.getActiveIdentity?.(input.key);
      case 'getCoalescingKey': return options.getCoalescingKey?.(job(input.job));
      case 'mergeJobs': return retain(hooks.mergeJobs!(input.jobs.map(job)));
      case 'refreshJob': {
        if (!hooks.refreshJob) return input.job;
        const refreshed = hooks.refreshJob(job(input.job));
        if (refreshed === undefined) return null;
        jobs.get(input.job)!.value = refreshed;
        return input.job;
      }
      case 'deliverMidTurn': {
        try { return hooks.deliverMidTurn?.(input.key, job(input.job)) ?? false; }
        finally { cleanup(input.job); }
      }
      case 'dispatch': {
        try { return Promise.resolve(hooks.dispatch(input.key, job(input.job))).finally(() => cleanup(input.job)); }
        catch (error) { cleanup(input.job); throw error; }
      }
      case 'onDiscard': options.onDiscard?.(job(input.job), input.reason); return;
      case 'canOpenTurn': {
        try { return options.canOpenTurn?.(job(input.job)) ?? true; }
        finally { cleanup(input.job); }
      }
      case 'retryDispatch': {
        try { return options.retryDispatch?.(callbacks.error(new Error(JSON.stringify(input.error))), job(input.job)) ?? true; }
        finally { cleanup(input.job); }
      }
      case 'predicate': return predicate!(input.key, input.job === undefined ? undefined : job(input.job));
      case 'runExclusive': {
        const run = runs.get(input.run)!;
        return Promise.resolve(run()).then(value => { const id = ++nextReference; results.set(id, value); return id; });
      }
      default: throw new Error(`Unknown native turn gate callback: ${name}`);
    }
  });
  const handle = new (loadBinding().NativeTurnGate)(JSON.stringify({
    bufferCap: options.bufferCap, recheckMs: options.recheckMs,
    reservationTtlMs: options.reservationTtlMs, mergeJobs: !!hooks.mergeJobs,
  }), callbacks.callback);
  const error = (failure: unknown): unknown => {
    const restored = callbacks.error(failure);
    if (callbacks.isOriginal(restored)) return restored;
    if (restored instanceof Error && (restored as Error & { code?: string }).code === 'TurnGateCapacityError') {
      return new TurnGateCapacityError((restored as Error & { details?: { sessionKey?: string } }).details?.sessionKey ?? '');
    }
    return restored;
  };
  function call<T>(name: string, payload: unknown): T {
    try { return JSON.parse(handle.call(name, JSON.stringify(payload), callbacks.callback)) as T; }
    catch (failure) { throw error(failure); }
  }
  async function start<T>(name: string, payload: unknown): Promise<T> {
    try { return JSON.parse(await handle.start(name, JSON.stringify(payload), callbacks.callback)) as T; }
    catch (failure) { throw error(failure); }
  }
  function filtered<T>(name: string, match: (key: string, job?: TJob) => boolean, reason?: string): T {
    const previous = predicate;
    predicate = match;
    try { return call(name, { reason }); }
    finally { predicate = previous; }
  }
  return {
    async deliver(key, value, onBusy: BusyDisposition = 'buffer') {
      const reference = retain(value);
      try { return await start<DeliverDisposition>('deliver', { key, job: reference, onBusy }); }
      finally { cleanup(reference); }
    },
    tryDeliverLive(key, value) {
      const reference = retain(value);
      try { return call('tryDeliverLive', { key, job: reference }); }
      finally { cleanup(reference); }
    },
    async runExclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
      const reference = ++nextReference;
      runs.set(reference, run);
      try {
        const result = await start<number>('runExclusive', { key, run: reference });
        const value = results.get(result) as T;
        results.delete(result);
        return value;
      } finally { runs.delete(reference); }
    },
    release: key => { call('release', { key }); },
    drain: key => { call('drain', { key }); },
    notifyReady: key => { call('notifyReady', { key }); },
    isOccupied: key => call('isOccupied', { key }),
    bufferedJobs: key => call<number[]>('bufferedJobs', { key }).map(job),
    bufferedCount: key => call('bufferedCount', { key }),
    hasBuffered: key => call<number>('bufferedCount', { key }) > 0,
    hasAnyBuffered: match => filtered('hasAnyBuffered', match),
    discard: (match, reason) => filtered('discard', match, reason),
    discardJobs: (match, reason) => filtered('discardJobs', (key, value) => match(key, value!), reason),
    park: key => { call('park', { key }); },
    putBack(key, values) {
      const references = values.map(retain);
      try { call('putBack', { key, jobs: references }); }
      finally { references.forEach(cleanup); }
    },
  };
}
