function aborted(): Error { return Object.assign(new Error('Operation aborted'), { name: 'AbortError' }); }

interface Waiter { owner: string; resolve(release: () => void): void; reject(error: Error): void; signal: AbortSignal; cancel(): void }
interface Lock { owner: string; waiters: Waiter[]; release(): void }

/** One coordinator per host module, shared by every worker pool it creates. */
export class LockCoordinator {
  private locks = new Map<string, Lock>();
  get size(): number { return this.locks.size; }

  acquire(key: string, owner: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { owner, resolve, reject, signal, cancel: () => {
        const lock = this.locks.get(key);
        if (lock) lock.waiters = lock.waiters.filter(item => item !== waiter);
        reject(aborted());
      } };
      const existing = this.locks.get(key);
      if (existing) {
        existing.waiters.push(waiter);
        signal.addEventListener('abort', waiter.cancel, { once: true });
      } else this.grant(key, waiter, []);
    });
  }

  private grant(key: string, waiter: Waiter, waiters: Waiter[]): void {
    waiter.signal.removeEventListener('abort', waiter.cancel);
    const lock: Lock = { owner: waiter.owner, waiters, release: () => {
      if (this.locks.get(key) !== lock) return;
      const next = lock.waiters.shift();
      if (next) this.grant(key, next, lock.waiters);
      else this.locks.delete(key);
    } };
    this.locks.set(key, lock);
    waiter.resolve(lock.release);
  }

  releaseOwner(owner: string): void {
    for (const lock of [...this.locks.values()]) {
      for (const waiter of [...lock.waiters]) {
        if (waiter.owner === owner) { waiter.signal.removeEventListener('abort', waiter.cancel); waiter.cancel(); }
      }
      if (lock.owner === owner) lock.release();
    }
  }
}

export const fileLocks = new LockCoordinator();
export const transcriptLocks = new LockCoordinator();
