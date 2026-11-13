import { nativeError, nativeErrorDetails, type NativeCollaborationCallback } from './binding.js';
import { decodeWire, encodeWire } from './wire.js';

export function createHostCallbacks(dispatch: (name: string, input: Record<string, any>) => unknown,
  options: { preserveErrors?: boolean; errorMode?: 'structured' | 'opaque'; errorDetails?: (error: unknown) => Record<string, unknown> } = {}): {
  callback: NativeCollaborationCallback; error(error: unknown): unknown; isOriginal(error: unknown): boolean; release(): void;
} {
  let nextError = 0;
  let released = false;
  const cancelled = '{"ok":false,"error":{"name":"AbortError","code":"ABORTED"}}';
  const weak = new Map<number, WeakRef<object>>(), strong = new Map<number, unknown>();
  const originals = new WeakSet<object>();
  const finalizer = new FinalizationRegistry<number>(id => weak.delete(id));
  const rejected = (error: unknown, data: boolean): string => {
    if (released) return cancelled;
    const source = error as { name?: string; message?: string; code?: string; harness?: unknown } | null;
    let errorRef: number | undefined;
    if (options.preserveErrors || options.errorMode === 'opaque') { errorRef = ++nextError; strong.set(errorRef, error); }
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      errorRef ??= ++nextError; weak.set(errorRef, new WeakRef(error)); originals.add(error); finalizer.register(error, errorRef);
    }
    try {
      const detail = options.errorMode === 'opaque' ? { errorRef } : { name: source?.name ?? 'Error', message: source?.message ?? String(error), code: source?.code,
        harness: source?.harness, stringValue: String(error), ...options.errorDetails?.(error), errorRef,
        ...(errorRef === undefined ? { thrownType: typeof error,
          thrown: typeof error === 'bigint' || typeof error === 'symbol' || (typeof error === 'number' && !Number.isFinite(error)) ? String(error) : error } : {}),
      };
      return JSON.stringify({ ok: false, ...(data ? { encoding: 'js-value-v1' } : {}), error: data ? encodeWire(detail) : detail });
    } catch {
      if (errorRef === undefined) { errorRef = ++nextError; strong.set(errorRef, error); }
      // Only the owned reference crosses when inspecting the rejected value fails.
      return data
        ? `{"ok":false,"encoding":"js-value-v1","error":{"version":1,"data":{"errorRef":${errorRef}},"extensions":[]}}`
        : `{"ok":false,"error":{"errorRef":${errorRef}}}`;
    }
  };
  const accepted = (value: unknown, data: boolean): string => released ? cancelled : JSON.stringify({ ok: true,
    ...(data ? { encoding: 'js-value-v1' } : {}), value: data ? encodeWire(value) : value });
  return {
    isOriginal(error) { return error !== null && (typeof error === 'object' || typeof error === 'function') && originals.has(error); },
    callback(error, name, input, asynchronous, complete) {
      const data = name === 'callData';
      let completed = false;
      const finish = (value: string): string => { if (asynchronous && !completed) { completed = true; complete!(value); } return value; };
      if (released) return finish(cancelled);
      if (error) return finish(rejected(error, data));
      try {
        const frame = JSON.parse(input);
        if (data) frame.params = decodeWire(frame.params);
        const result = dispatch(data ? 'call' : name, frame);
        if (asynchronous && result && (typeof result === 'object' || typeof result === 'function') && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).then(value => { try { return accepted(value, data); } catch (error) { return rejected(error, data); } }, error => rejected(error, data)).then(finish); return '';
        }
        return finish(accepted(result, data));
      } catch (error) { return finish(rejected(error, data)); }
    },
    error(error) {
      const detail = nativeErrorDetails(error) as { errorRef?: number; thrown?: unknown; thrownType?: string } | undefined;
      if (detail?.errorRef !== undefined) {
        if (strong.has(detail.errorRef)) { const value = strong.get(detail.errorRef); strong.delete(detail.errorRef); weak.delete(detail.errorRef); return value; }
        const original = weak.get(detail.errorRef)?.deref(); weak.delete(detail.errorRef); if (original) return original;
      }
      if (detail?.thrownType === 'undefined') return undefined;
      if (detail?.thrownType === 'bigint') return BigInt(detail.thrown as string);
      if (detail?.thrownType === 'number' && typeof detail.thrown === 'string') return Number(detail.thrown);
      if (detail && Object.hasOwn(detail, 'thrown')) return detail.thrown;
      return nativeError(error);
    },
    release() { released = true; strong.clear(); weak.clear(); },
  };
}
