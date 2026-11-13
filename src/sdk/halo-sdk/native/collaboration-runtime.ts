import { loadBinding, stringifyNativeValue, type NativeCollaborationRuntimeHandle } from './binding.js';
import { createCollaborationCallbacks } from './collaboration-callbacks.js';
import { collaborationValue } from './collaboration-values.js';
import { COLLABORATION_TOOL_NAMES, CollaborationRefusal, createCollaborationServer } from './collaboration-contract.js';
import { messageBusFacade } from './message-bus.js';
import type { MessageBus } from '../collaboration/message-bus.js';
import type { CollaborationRuntimeOptions } from '../collaboration/runtime.js';
import type { CollaborationCallContext, CollaborationOperations, CollaborationResult, CollaborationServer, SpawnInput } from '../collaboration/types.js';
export type { CollaborationMember, CollaborationExecutor, CollaborationScopeStore, CollaborationRuntimeOptions, MemberExecutionRequest } from '../collaboration/runtime.js';

export class CollaborationRuntime {
  readonly coordinatorId: string;
  readonly bus: MessageBus;
  private readonly handle: NativeCollaborationRuntimeHandle;
  private readonly callbacks;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private nextOperation = 0;
  private closing?: Promise<void>;

  constructor(options: CollaborationRuntimeOptions) {
    const weak = new WeakRef(this);
    const facade = messageBusFacade();
    this.callbacks = createCollaborationCallbacks((name, input) => {
      switch (name) {
        case 'store.getMember': return options.store.getMember(input.id);
        case 'store.findMember': return options.store.findMember(input.name);
        case 'store.members': return options.store.members();
        case 'store.tasks': return options.store.tasks();
        case 'store.findings': return options.store.findings();
        case 'store.activities': return options.store.activities();
        case 'store.getTaskById': return options.store.getTaskById(input.id);
        case 'store.addMember': return options.store.addMember(input.value);
        case 'store.removeMember': return options.store.removeMember(input.id);
        case 'store.insertTask': return options.store.insertTask(input.value);
        case 'store.updateTask': return options.store.updateTask(input.id, input.patch, input.now);
        case 'store.insertFinding': return options.store.insertFinding(input.value);
        case 'store.insertActivity': return options.store.insertActivity(input.value);
        case 'store.flush': return options.store.flush();
        case 'executor.execute': {
          const runtime = weak.deref();
          if (!runtime) throw new Error('The collaboration runtime is closed.');
          const controller = new AbortController();
          runtime.controllers.set(input.reference, controller);
          if (runtime.cancelled.delete(input.reference)) controller.abort();
          try {
            return Promise.resolve(options.executor.execute({ member: input.member, deliveries: input.deliveries, signal: controller.signal,
              server: runtime.serverFor(input.member.id), ready: () => { runtime.call('executionReady', { reference: input.reference }); },
            })).finally(() => runtime.controllers.delete(input.reference));
          } catch (error) { runtime.controllers.delete(input.reference); throw error; }
        }
        case 'executor.inject': return options.executor.inject(input.memberId, input.deliveries);
        case 'executor.interrupt': return options.executor.interrupt(input.memberId);
        case 'executor.release': return options.executor.release(input.memberId);
        case 'executor.readMember': return options.executor.readMember(input.memberId, input.before ?? undefined);
        case 'executor.readArtifact': return options.executor.readArtifact(input.ref, input.requesterId);
        case 'executor.validateArtifact': return options.executor.validateArtifact(input.ref, input.producerId);
        case 'runtime.onChange': return options.onChange?.();
        case 'runtime.deliverToSource': return options.deliverToSource(input.envelope, input.trigger);
        case 'runtime.executionCancelled': {
          const runtime = weak.deref();
          const controller = runtime?.controllers.get(input.reference);
          if (controller) controller.abort(); else runtime?.cancelled.add(input.reference);
          return;
        }
        case 'runtime.executionReleased': {
          const runtime = weak.deref();
          runtime?.controllers.get(input.reference)?.abort();
          runtime?.controllers.delete(input.reference); runtime?.cancelled.delete(input.reference);
          return;
        }
        default: return facade.dispatch(name, input);
      }
    });
    this.handle = new (loadBinding().NativeCollaborationRuntime)(stringifyNativeValue({
      teamId: options.store.teamId, epochId: options.store.epochId, maxConcurrentTurns: options.maxConcurrentTurns,
      maxMembers: options.maxMembers, ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      origin: options.origin ?? null, onChange: !!options.onChange,
    }), this.callbacks.callback);
    this.coordinatorId = this.call('coordinatorId');
    this.bus = facade.bind(this.handle.bus(), this.callbacks);
  }
  private failure(error: unknown): unknown {
    const failure = this.callbacks.error(error) as Error & { code?: string; details?: { teamId: string; epochId: string; taskId?: string } };
    if (this.callbacks.isOriginal(failure)) return failure;
    if (failure instanceof CollaborationRefusal) return failure;
    if (failure && collaborationValue('isRefusal', { code: failure.code, message: failure.message, details: failure.details })) {
      return new CollaborationRefusal(failure.code!, failure.message, failure.details);
    }
    return failure;
  }
  private call<T>(name: string, input: unknown = {}): T {
    try { return JSON.parse(this.handle.call(name, JSON.stringify(input), this.callbacks.callback)) as T; }
    catch (error) { throw this.failure(error); }
  }
  private async start<T>(name: string, input: unknown = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const id = String(++this.nextOperation);
    const abort = () => this.handle.cancel(id);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const pending = this.handle.start(name, JSON.stringify(input), id, this.callbacks.callback);
      if (signal?.aborted) abort();
      return JSON.parse(await pending) as T;
    } catch (error) { throw this.failure(error); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  get activeCount(): number { return this.call('activeCount'); }
  get revision(): number { return this.call('revision'); }
  beginRequest(): boolean { return this.call('beginRequest'); }
  waitForChange(after: number, signal?: AbortSignal): Promise<void> {
    return signal?.aborted ? Promise.resolve() : this.start('waitForChange', { after }, signal);
  }
  spawn(callerId: string, input: SpawnInput, signal?: AbortSignal): Promise<string> { return this.start('spawn', { callerId, input }, signal); }
  send(callerId: string, to: string, message: string, signal?: AbortSignal): Promise<string> { return this.start('send', { callerId, to, message }, signal); }
  stop(callerId: string, to: string): Promise<string> { return this.start('stop', { callerId, to }); }
  serverFor(callerId = this.coordinatorId): CollaborationServer {
    const operations = Object.fromEntries(COLLABORATION_TOOL_NAMES.map(name => [name,
      (input: unknown, context: CollaborationCallContext) => this.start<CollaborationResult>('tool', { callerId, name, input }, context.signal),
    ])) as CollaborationOperations;
    return createCollaborationServer(operations);
  }
  close(): Promise<void> {
    this.closing ??= this.start<void>('close').finally(() => {
      for (const controller of this.controllers.values()) controller.abort();
      this.controllers.clear(); this.cancelled.clear();
    });
    return this.closing;
  }
}
