import { loadBinding, routeNativeLog, stringifyNativeValue, type NativeSdkCollaborationHandle } from './binding.js';
import { NativeCallbacks } from './callbacks.js';
import { createCollaborationCallbacks } from './collaboration-callbacks.js';
import { collaborationValue } from './collaboration-values.js';
import { COLLABORATION_TOOL_NAMES, collaborationText } from './collaboration-contract.js';
import { getLogger } from '../utils/logger.js';
import type { Options } from '../types/config.js';
import type { ExecutionBudget } from '../core/execution-budget.js';
import type { CollaborationResult, CollaborationServer, CollaborationToolDescriptor } from '../collaboration/types.js';
import type { LocalCollaborationOptions, SdkCollaborationBinding } from '../collaboration/sdk/index.js';
import type { TeamEnvelope, TeamTriggerContext } from '../collaboration/protocol.js';
export { appendCollaborationPrompt, localCollaborationSettings } from './collaboration-contract.js';
export type { LocalCollaborationOptions, SdkCollaborationBinding } from '../collaboration/sdk/index.js';

interface OptionsReference { options: Options; scopes: Set<number>; view: Record<string, unknown> }
interface CallbackScope { callbacks: NativeCallbacks; reference: number; attached: boolean }

export function createSdkCollaboration(options: {
  sessionId: string;
  getOptions(): Options;
  settings?: LocalCollaborationOptions;
  deliverToSource(envelope: TeamEnvelope, trigger: TeamTriggerContext): Promise<'dispatched' | 'mid_turn' | 'buffered'>;
}): SdkCollaborationBinding {
  const references = new Map<number, OptionsReference>();
  const scopes = new Map<number, CallbackScope>();
  const identities = new WeakMap<object, number>();
  let nextReference = 0;
  let nextOperation = 0;
  let handleReference: WeakRef<NativeSdkCollaborationHandle>;
  let closing: Promise<void> | undefined;
  const identity = (object: object | undefined): number | undefined => {
    if (!object) return undefined;
    let id = identities.get(object);
    if (id === undefined) { id = ++nextReference; identities.set(object, id); }
    return id;
  };
  const closeScope = async (id: number): Promise<void> => {
    const scope = scopes.get(id);
    if (!scope) return;
    scopes.delete(id);
    references.get(scope.reference)?.scopes.delete(id);
    await scope.callbacks.close();
  };
  const retireScope = (id: number): void => {
    void closeScope(id).catch(error => getLogger('Collaboration').warn('Callback scope cleanup failed', { error: String(error) }));
  };
  const callbacks = createCollaborationCallbacks((name, input) => {
    switch (name) {
      case 'getOptions': {
        const base = options.getOptions();
        const reference = ++nextReference;
        const { abortController: _abort, provider, customTools, mcpServers, hooks, canUseTool,
          stderr: _stderr, onElicitation: _elicitation, ...data } = base;
        const view = {
          ...data,
          customTools: customTools?.map(tool => ({ name: tool.name })),
          mcpServers: mcpServers && Object.fromEntries(Object.entries(mcpServers).map(([key, server]) =>
            [key, server.type === 'sdk' ? { type: server.type, name: server.name } : server])),
          nativeOptionsRef: reference,
          nativePolicyReferences: { provider: identity(provider), approval: identity(canUseTool), hooks: identity(hooks), tools: customTools?.map(identity) },
        };
        references.set(reference, { options: { ...base }, scopes: new Set(), view: JSON.parse(JSON.stringify(view)) });
        return view;
      }
      case 'releaseOptions': {
        const reference = references.get(input.reference);
        references.delete(input.reference);
        if (reference) for (const scope of reference.scopes) if (!scopes.get(scope)?.attached) retireScope(scope);
        return;
      }
      case 'prepareOptions': {
        const reference = references.get(input.options.nativeOptionsRef);
        if (!reference) throw new Error('The collaboration options snapshot is unavailable.');
        const transport = handleReference.deref();
        if (!transport) throw new Error('The collaboration callback transport is unavailable.');
        const scope = ++nextReference;
        const native = new NativeCallbacks();
        native.attach(transport);
        try {
          const encoded = native.encode(reference.options);
          const prepared: Record<string, unknown> = { ...encoded, nativeCallbackScope: scope };
          for (const key of Object.keys(reference.view)) if (!Object.hasOwn(input.options, key)) delete prepared[key];
          for (const [key, value] of Object.entries(input.options)) {
            if (!Object.hasOwn(reference.view, key) || JSON.stringify(value) !== JSON.stringify(reference.view[key])) prepared[key] = value;
          }
          scopes.set(scope, { callbacks: native, reference: input.options.nativeOptionsRef, attached: false });
          reference.scopes.add(scope);
          return prepared;
        } catch (error) {
          void native.close().catch(cleanup => getLogger('Collaboration').warn('Unprepared callback scope cleanup failed', { error: String(cleanup) }));
          throw error;
        }
      }
      case 'attachScope': { const scope = scopes.get(input.scope); if (scope) scope.attached = true; return; }
      case 'detachScope': retireScope(input.scope); return;
      case 'hostCall': {
        const scope = scopes.get(input.scope);
        if (!scope) throw new Error('The collaborator callback scope is closed.');
        return scope.callbacks.call(input.id, input.method, input.params);
      }
      case 'cancelCallback': scopes.get(input.scope)?.callbacks.cancel(input.id); return;
      case 'log': routeNativeLog(input.record); return;
      case 'deliverToSource': return options.deliverToSource(input.envelope, input.trigger);
      default: throw new Error(`Unknown SDK collaboration callback: ${name}`);
    }
  });
  const handle = new (loadBinding().NativeSdkCollaboration)(stringifyNativeValue({ sessionId: options.sessionId, settings: options.settings ?? {} }), callbacks.callback);
  handleReference = new WeakRef(handle);
  const call = <T>(name: string, input: unknown = {}): T => {
    try { return JSON.parse(handle.call(name, stringifyNativeValue(input), callbacks.callback)) as T; }
    catch (error) { throw callbacks.error(error); }
  };
  const start = async <T>(name: string, input: unknown = {}, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const operation = String(++nextOperation);
    const abort = () => handle.cancel(operation);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const promise = handle.start(name, JSON.stringify(input), operation, callbacks.callback);
      if (signal?.aborted) abort();
      return JSON.parse(await promise) as T;
    } catch (error) { throw callbacks.error(error); }
    finally { signal?.removeEventListener('abort', abort); }
  };
  const server: CollaborationServer = {
    type: 'sdk', name: 'halo-team', instance: {
      name: 'halo-team', version: '2.0.0',
      listTools: () => call<CollaborationToolDescriptor[]>('definitions'),
      async callTool(name, input, context = {}) {
        if (!COLLABORATION_TOOL_NAMES.includes(name as typeof COLLABORATION_TOOL_NAMES[number])) return undefined;
        if (context.signal?.aborted) { console.warn(`[Collaboration] Cancelled before execution: tool=${name}`); return collaborationText(collaborationValue<string>('feedback', { kind: 'cancelled' }), true); }
        try { return await start<CollaborationResult>('tool', { name, input }, context.signal); }
        catch (error) {
          console.error(`[Collaboration] Operation failed: tool=${name}`, error);
          try { return call<CollaborationResult>('operationFailed'); }
          catch { return collaborationText(collaborationValue<string>('feedback', { kind: 'failed' }), true); }
        }
      },
    },
  };
  const budget = {
    observe(usage: unknown) { call('budget.observe', usage); },
    get spent() { return call<number>('budget.spent'); },
    get total() { return call<number>('budget.total'); },
    resetRequest() { call('budget.resetRequest'); },
  } as ExecutionBudget;
  return {
    server, budget,
    get activeCount() { return call<number>('activeCount'); },
    get residentCount() { return call<number>('residentCount'); },
    get retainedCount() { return call<number>('retainedCount'); },
    get revision() { return call<number>('revision'); },
    drainUsage: () => call('drainUsage'),
    beginRequest: () => { call('beginRequest'); },
    waitForChange: (after, signal) => signal?.aborted ? Promise.resolve() : start('waitForChange', { after }, signal),
    stopAll: () => start('stopAll'),
    flush: () => start('flush'),
    close() {
      closing ??= start<void>('close').finally(async () => {
        references.clear();
        await Promise.all([...scopes.keys()].map(closeScope));
      });
      return closing;
    },
  };
}
