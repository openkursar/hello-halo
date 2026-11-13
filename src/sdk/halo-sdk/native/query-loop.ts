import type { Options, QueryConfig } from '../types/config.js';
import type { QueryLoopOptions, SDKMessage } from '../core/query-types.js';
import type { LlmProvider, Message } from '../types/provider.js';
import type { Tool } from '../types/tool.js';
import { getLogger } from '../utils/logger.js';
import { AbortError, isAbortError } from '../utils/errors.js';
import { NativeCallbacks } from './callbacks.js';
import { callbackError, loadBinding, nativeError, routeNativeLog, stringifyNativeValue, type NativeLoopHandle } from './binding.js';
import { tokenBudgetHandle, wrapTokenBudget } from './values.js';
import { toolDiscoveryHandle } from './tool-discovery.js';

interface EventFrame { event: SDKMessage; eventId: string; progress: 'before' | 'after' | 'none'; bytes: number }

export async function* queryLoop(config: QueryConfig, provider: LlmProvider, tools: Tool[], initialPrompt: string | Message[], options: QueryLoopOptions = {}): AsyncGenerator<SDKMessage, void, undefined> {
  const callbacks = new NativeCallbacks(); callbacks.bindLoop(config, options);
  const { abortSignal, ...plain } = config;
  const encoded = callbacks.encode({ ...plain, provider, ...{ nativeOwner: {
    ...(options.recordFileChange ? { recordFileChange: options.recordFileChange } : {}),
    ...(options.readFileState ? { externalReadFileState: true } : {}),
    backgroundTasksPresent: Boolean(options.toolServices?.backgroundTasks),
    externalBackgroundTasks: Boolean(options.toolServices?.backgroundTasks),
  } } } as unknown as Options);
  const supplied = callbacks.encodeTools(tools, true);
  const contextState = options.contextState;
  const budget = contextState ? tokenBudgetHandle(contextState.budget) : undefined;
  if (contextState && !budget) { await callbacks.close(); throw new TypeError('Public native queryLoop requires a native TokenBudget in contextState'); }
  const data = {
    callbacks: Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value === 'function').map(([name]) => [name, true])),
    hasConfigOverrides: options.configOverrides !== undefined,
    ...(contextState ? { contextState: { sameProvider: contextState.provider === provider, model: contextState.model,
      compactedHistoryTokens: contextState.compactedHistoryTokens, deferredCompactionTokens: contextState.deferredCompactionTokens } } : {}),
    ...(options.toolContext === null ? { toolContext: null } : options.toolContext ? { toolContext: { snapshot: options.toolContext.snapshot() } } : {}),
    sessionId: options.sessionId, transcriptPath: options.transcriptPath, completedTurns: options.completedTurns,
    mcpServerStatuses: options.mcpServerStatuses, slashCommands: options.slashCommands, skills: options.skills, skillCatalog: options.skillCatalog,
  };
  let handle: NativeLoopHandle;
  try { handle = new (loadBinding().NativeLoop)(JSON.stringify(encoded), stringifyNativeValue(supplied), stringifyNativeValue(initialPrompt), JSON.stringify(data), budget, toolDiscoveryHandle(options.toolContext)); }
  catch (error) { await callbacks.close(); throw nativeError(error); }
  callbacks.attach(handle);
  const receipt = JSON.parse(handle.contextReceipt()) as { budgetReplaced: boolean; runId: string; sessionId: string };
  if (contextState) {
    if (receipt.budgetReplaced) {
      contextState.budget = wrapTokenBudget(handle.tokenBudget());
      contextState.compactedHistoryTokens = undefined; contextState.deferredCompactionTokens = undefined;
    }
    contextState.model = config.model; contextState.provider = provider;
  }
  const queue: EventFrame[] = [];
  const cancelled = () => callbackError(new AbortError());
  let bytes = 0, closing = false, ended = false, failure: unknown, cleanupFailure: unknown, cleanupFailed = false;
  let wake: (() => void) | undefined, capacity: (() => void) | undefined;
  const abort = () => { callbacks.abort(); handle.interrupt(); };
  const respond = async (id: string, method: string, params: unknown) => {
    try {
      if (closing && (method === 'tools.execute' || method === 'provider.start')) throw new AbortError();
      handle.callbackResponse(id, stringifyNativeValue(await callbacks.call(id, method, params)));
    }
    catch (error) {
      if (closing && method === 'loop.call' && !isAbortError(error) && !cleanupFailed) { cleanupFailure = error; cleanupFailed = true; }
      try { handle.callbackResponse(id, 'null', callbackError(error)); }
      catch (failure) { if (!closing) getLogger('Native').warn('Public loop callback response could not be delivered', { sessionId: receipt.sessionId, method, error: String(failure) }); }
    }
  };
  const pump = (async () => {
    try {
      while (true) {
        const raw = await handle.next(); if (raw === null) break;
        const envelope = JSON.parse(raw);
        if (envelope.kind === 'callback') void respond(envelope.id, envelope.method, envelope.params);
        else if (envelope.kind === 'callbackCancelled') callbacks.cancel(envelope.id);
        else if (envelope.kind === 'log') routeNativeLog(envelope.record);
        else if (envelope.kind === 'closed') break;
        else if (envelope.kind === 'error') throw nativeError(new Error(raw));
        else if (envelope.kind === 'event') {
          if (closing) { handle.eventConsumed(envelope.eventId, cancelled()); continue; }
          if (envelope.progress === 'before') {
            try { options.onProgress?.(envelope.event); }
            catch (error) { handle.eventConsumed(envelope.eventId, callbackError(error)); continue; }
          }
          while (!closing && (queue.length >= 256 || bytes >= 4 * 1024 * 1024)) await new Promise<void>(resolve => { capacity = resolve; });
          if (closing) { handle.eventConsumed(envelope.eventId, cancelled()); continue; }
          const size = raw.length * 2;
          queue.push({ event: envelope.event, eventId: envelope.eventId, progress: envelope.progress, bytes: size }); bytes += size;
          wake?.(); wake = undefined;
        } else throw new Error(`Unknown public loop envelope: ${String(envelope.kind)}`);
      }
    } catch (error) {
      failure = nativeError(error); handle.close();
      if (!closing && !abortSignal.aborted) getLogger('Native').warn('Public query loop transport failed', { sessionId: receipt.sessionId, error: String(failure) });
    }
    finally { callbacks.closeCatalogViews(); ended = true; wake?.(); wake = undefined; capacity?.(); capacity = undefined; }
  })();
  abortSignal.addEventListener('abort', abort, { once: true });
  if (abortSignal.aborted) abort();
  try {
    while (true) {
      if (failure) throw failure;
      const frame = queue.shift();
      if (!frame) { if (ended) return; await new Promise<void>(resolve => { wake = resolve; }); continue; }
      bytes -= frame.bytes; capacity?.(); capacity = undefined;
      let consumed = false;
      try {
        yield frame.event;
        try { if (frame.progress === 'after') options.onProgress?.(frame.event); }
        catch (error) { handle.eventConsumed(frame.eventId, callbackError(error)); consumed = true; throw error; }
        handle.eventConsumed(frame.eventId); consumed = true;
      } finally { if (!consumed) handle.eventConsumed(frame.eventId, cancelled()); }
    }
  } finally {
    closing = true; abortSignal.removeEventListener('abort', abort); callbacks.abort(); handle.interrupt();
    for (const frame of queue.splice(0)) handle.eventConsumed(frame.eventId, cancelled());
    bytes = 0; capacity?.(); capacity = undefined;
    try { await pump; await handle.waitClosed(); }
    finally { handle.close(); await callbacks.close(); }
    if (cleanupFailed) throw cleanupFailure;
    if (failure && !isAbortError(failure)) throw failure;
  }
}
