import { callbackError, nativeError, type NativeCollaborationCallback } from './binding.js';
import { CollaborationRefusal } from '../collaboration/errors.js';

export function createCollaborationCallbacks(dispatch: (name: string, input: Record<string, any>) => unknown): {
  callback: NativeCollaborationCallback;
  error(error: unknown): unknown;
  isOriginal(error: unknown): boolean;
} {
  let nextError = 0;
  const errors = new Map<number, WeakRef<object>>();
  const originals = new WeakSet<object>();
  const finalizer = new FinalizationRegistry<number>(id => errors.delete(id));
  const rejected = (error: unknown): string => {
    let errorRef: number | undefined;
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      errorRef = ++nextError;
      errors.set(errorRef, new WeakRef(error));
      originals.add(error);
      finalizer.register(error, errorRef);
    }
    return JSON.stringify({ ok: false, error: {
      ...JSON.parse(callbackError(error)),
      collaborationRefusal: error instanceof CollaborationRefusal,
      errorRef, ...(errorRef === undefined ? { thrownType: typeof error,
        thrown: typeof error === 'bigint' || typeof error === 'symbol' || (typeof error === 'number' && !Number.isFinite(error)) ? String(error) : error } : {}),
    } });
  };
  const accepted = (value: unknown): string => JSON.stringify({ ok: true, value });
  return {
    isOriginal(error) { return error !== null && (typeof error === 'object' || typeof error === 'function') && originals.has(error); },
    callback(error, name, input, asynchronous, complete) {
      const finish = (value: string): string => { if (asynchronous) complete!(value); return value; };
      if (error) return finish(rejected(error));
      try {
        const result = dispatch(name, JSON.parse(input));
        if (asynchronous) { void Promise.resolve(result).then(value => { try { return accepted(value); } catch (error) { return rejected(error); } }, rejected).then(finish); return ''; }
        return accepted(result);
      } catch (error) { return finish(rejected(error)); }
    },
    error(error) {
      const converted = nativeError(error) as Error & { details?: { errorRef?: number; thrown?: unknown; thrownType?: string } };
      const detail = converted.details;
      if (detail?.thrownType === 'undefined') return undefined;
      if (detail?.thrownType === 'bigint') return BigInt(detail.thrown as string);
      if (detail?.thrownType === 'number' && typeof detail.thrown === 'string') return Number(detail.thrown);
      if (detail && Object.hasOwn(detail, 'thrown')) return detail.thrown;
      if (detail?.errorRef !== undefined) {
        const original = errors.get(detail.errorRef)?.deref();
        errors.delete(detail.errorRef);
        if (original) return original;
      }
      return converted;
    },
  };
}
