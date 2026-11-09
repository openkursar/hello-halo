/** Cancellation helpers shared by model streaming and tool execution. */
import { AbortError } from '../utils/errors.js';

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortError(signal.reason ?? 'Operation was aborted');
}

/** Observe late rejections even when cancellation wins the race. */
export function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(new AbortError(signal.reason ?? 'Operation was aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new AbortError(signal.reason ?? 'Operation was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
