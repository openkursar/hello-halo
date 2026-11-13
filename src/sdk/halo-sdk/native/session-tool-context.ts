import type { ReadSessionToolContextModeOptions, SessionToolContextMode } from '../core/session-tool-context.js';
import { loadBinding, nativeError } from './binding.js';

export async function readSessionToolContextMode(sessionId: string, options: ReadSessionToolContextModeOptions,
  controls: { signal?: AbortSignal } = {}): Promise<SessionToolContextMode> {
  controls.signal?.throwIfAborted();
  const inspection = new (loadBinding().NativeHistoryRead)(sessionId, JSON.stringify(options));
  const cancel = () => inspection.cancel();
  controls.signal?.addEventListener('abort', cancel, { once: true });
  if (controls.signal?.aborted) cancel();
  try { return await inspection.result() as SessionToolContextMode; }
  catch (error) { if (controls.signal?.aborted) throw controls.signal.reason; throw nativeError(error); }
  finally { controls.signal?.removeEventListener('abort', cancel); }
}
