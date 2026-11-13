import { getLogger } from '../utils/logger.js';
import type { Options } from '../types/config.js';
import { NativeCallbacks } from './callbacks.js';
import { callbackError, loadBinding, nativeError, parseNativeValue, routeNativeLog, stringifyNativeValue, type NativeOperationHandle } from './binding.js';

export async function runPublic<T>(operation: string, options: Record<string, unknown>, payload: unknown, signal?: AbortSignal,
  controls: { callbacks?: NativeCallbacks; result?: (value: any, callbacks: NativeCallbacks) => T; advisoryCancellation?: boolean; decodeValues?: boolean;
    createHandle?: (options: string, payload: string) => NativeOperationHandle } = {}): Promise<T> {
  if (!controls.advisoryCancellation) signal?.throwIfAborted();
  const callbacks = controls.callbacks ?? new NativeCallbacks();
  let handle: NativeOperationHandle | undefined;
  const abort = () => { callbacks.abort(); if (controls.advisoryCancellation) handle?.interrupt(); else handle?.close(); };
  const respond = async (id: string, method: string, params: unknown) => {
    try {
      const result = await callbacks.call(id, method, params);
      handle!.callbackResponse(id, stringifyNativeValue(result));
    } catch (error) {
      try { handle!.callbackResponse(id, 'null', callbackError(error)); }
      catch (failure) { if (!signal?.aborted) getLogger('Native').warn('Public operation callback response could not be delivered', { operation, method, error: String(failure) }); }
    }
  };
  try {
    const encoded = callbacks.encode(options as Options, { providerCapabilities: false });
    handle = controls.createHandle ? controls.createHandle(JSON.stringify(encoded), stringifyNativeValue(payload))
      : new (loadBinding().NativeOperation)(operation, JSON.stringify(encoded), stringifyNativeValue(payload));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    while (true) {
      if (!controls.advisoryCancellation) signal?.throwIfAborted();
      const raw = await handle.next();
      if (raw === null) throw new Error('Native operation ended without a result');
      const envelope = JSON.parse(raw);
      if (envelope.kind === 'callback') { void respond(envelope.id, envelope.method, envelope.params); }
      else if (envelope.kind === 'callbackCancelled') callbacks.cancel(envelope.id);
      else if (envelope.kind === 'log') routeNativeLog(envelope.record);
      else if (envelope.kind === 'result') {
        const value = controls.decodeValues === false ? envelope.result : parseNativeValue(JSON.stringify(envelope.result));
        return controls.result ? controls.result(value, callbacks) : value as T;
      } else if (envelope.kind === 'error') throw nativeError(new Error(raw));
      else if (envelope.kind === 'closed') throw new Error('Native operation ended without a result');
      else if (envelope.kind !== 'event') throw new Error(`Unknown native operation envelope: ${String(envelope.kind)}`);
    }
  } catch (error) { if (!controls.advisoryCancellation) signal?.throwIfAborted(); throw nativeError(error); }
  finally { signal?.removeEventListener('abort', abort); callbacks.abort(); handle?.close(); await handle?.waitClosed(); await callbacks.close(); }
}
