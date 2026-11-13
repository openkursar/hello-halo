import { loadBinding, type NativeTurnGateHandle } from './binding.js';
import { createCollaborationCallbacks } from './collaboration-callbacks.js';
import { collaborationValue } from './collaboration-values.js';
import type { CircuitBreachEvent, CircuitBreachReason, MessageBus, MessageBusDeps, TurnCompletion } from '../collaboration/message-bus.js';
import type { TeamTriggerContext } from '../collaboration/protocol.js';
export type * from '../collaboration/message-bus.js';
export type { MessageBusStore, MessagingMember } from '../collaboration/message-store.js';

export class TeamBusError extends Error {}
export class TopologyError extends TeamBusError {
  constructor(readonly toMemberName: string) { super(collaborationValue('errorText', { kind: 'contact', name: toMemberName })); this.name = 'TopologyError'; }
}
export class UnknownMemberError extends TeamBusError {
  constructor(readonly memberName: string) { super(collaborationValue('errorText', { kind: 'member', name: memberName })); this.name = 'UnknownMemberError'; }
}
export class CircuitBreakerError extends TeamBusError {
  constructor(readonly reason: CircuitBreachReason, message: string) { super(message); this.name = 'CircuitBreakerError'; }
}
export function isPersonsOwnDelivery(trigger: TeamTriggerContext): boolean { return collaborationValue('isPersonsOwnDelivery', trigger); }

type Callbacks = ReturnType<typeof createCollaborationCallbacks>;
function busError(callbacks: Callbacks, error: unknown): unknown {
  const failure = callbacks.error(error) as Error & { code?: string; details?: Record<string, any> };
  if (callbacks.isOriginal(failure)) return failure;
  if (failure?.code === 'TopologyError') return new TopologyError(failure.details?.toMemberName ?? '');
  if (failure?.code === 'UnknownMemberError') return new UnknownMemberError(failure.details?.memberName ?? '');
  if (failure?.code === 'CircuitBreakerError') return new CircuitBreakerError(failure.details?.reason, failure.message);
  if (failure?.code === 'TeamBusError') return new TeamBusError(failure.message);
  return failure;
}

export function messageBusFacade() {
  let reference = 0;
  let handleReference: WeakRef<NativeTurnGateHandle>;
  let bridge: Callbacks;
  const listeners = new Map<number, (event: CircuitBreachEvent) => void>();
  const runs = new Map<number, () => Promise<unknown>>();
  const results = new Map<number, unknown>();
  const finalizer = new FinalizationRegistry<string>(reference => {
    const handle = handleReference.deref();
    if (handle) handle.call('releaseRemote', JSON.stringify({ reference }), bridge.callback);
  });
  return {
    remoteCompletion(reference: string): (outcome: TurnCompletion) => void {
      const complete = (outcome: TurnCompletion) => {
        const handle = handleReference.deref();
        if (handle) {
          try { handle.call('remoteCompletion', JSON.stringify({ reference, outcome }), bridge.callback); }
          catch (error) { throw busError(bridge, error); }
        }
      };
      finalizer.register(complete, reference);
      return complete;
    },
    dispatch(name: string, input: Record<string, any>): unknown {
      if (name === 'bus.onBreach') return listeners.get(input.reference)?.(input.event);
      if (name === 'bus.runRelayedTurn') {
        const run = runs.get(input.reference)!;
        return Promise.resolve(run()).then(value => { const id = ++reference; results.set(id, value); return id; });
      }
      throw new Error(`Unknown native message bus callback: ${name}`);
    },
    bind(handle: NativeTurnGateHandle, callbacks: Callbacks): MessageBus {
      handleReference = new WeakRef(handle);
      bridge = callbacks;
      const call = <T>(name: string, input: unknown): T => {
        try { return JSON.parse(handle.call(name, JSON.stringify(input), callbacks.callback)) as T; }
        catch (error) { throw busError(callbacks, error); }
      };
      const start = async <T>(name: string, input: unknown): Promise<T> => {
        try { return JSON.parse(await handle.start(name, JSON.stringify(input), callbacks.callback)) as T; }
        catch (error) { throw busError(callbacks, error); }
      };
      return {
        send: input => start('send', input),
        async deliverRuntimeWake(input) {
          const result = await start<{ disposition: Awaited<ReturnType<MessageBus['deliverRuntimeWake']>>; envelope: object; trigger: object }>('deliverRuntimeWake', input);
          Object.assign(input.envelope, result.envelope); Object.assign(input.trigger, result.trigger);
          return result.disposition;
        },
        notifySessionReady: sessionKey => { call('notifySessionReady', { sessionKey }); },
        holdSession: sessionKey => call('holdSession', { sessionKey }),
        cancelSession: sessionKey => { call('cancelSession', { sessionKey }); },
        continueSession: sessionKey => { call('continueSession', { sessionKey }); },
        returnDeliveries: (sessionKey, deliveries) => { call('returnDeliveries', { sessionKey, deliveries }); },
        returnHeldBack: (sessionKey, deliveries) => call('returnHeldBack', { sessionKey, deliveries }),
        async runRelayedTurn<T>({ sessionKey, run }: { sessionKey: string; run: () => Promise<T> }): Promise<T> {
          const id = ++reference;
          runs.set(id, run);
          try { const result = await start<number>('runRelayedTurn', { sessionKey, reference: id }); const value = results.get(result) as T; results.delete(result); return value; }
          finally { runs.delete(id); }
        },
        completeTurn: input => { call('completeTurn', input); },
        assertCanContact: (teamId, fromAppId, toAppId, collabMode, epochId) => { call('assertCanContact', { teamId, fromAppId, toAppId, collabMode, epochId }); },
        resolveMemberAppId: (teamId, memberName, epochId) => call('resolveMemberAppId', { teamId, memberName, epochId }),
        resolvePendingWaitsForMember: (appId, outcome) => call('resolvePendingWaitsForMember', { appId, outcome }),
        getEpochStats: epochId => call('getEpochStats', { epochId }),
        resetEpoch: epochId => { call('resetEpoch', { epochId }); },
        resetCircuit: epochId => { call('resetCircuit', { epochId }); },
        tripExternal: (teamId, epochId, reason) => { call('tripExternal', { teamId, epochId, reason }); },
        onBreach(listener) {
          const id = ++reference;
          listeners.set(id, listener);
          const token = call<number>('onBreach', { reference: id });
          return () => { call('removeBreachListener', { listener: token }); listeners.delete(id); };
        },
        getPendingRecordedInputIds: sessionKey => call('getPendingRecordedInputIds', { sessionKey }),
        hasBufferedMessages: epochId => call('hasBufferedMessages', { epochId }),
        isSessionOccupied: sessionKey => call('isSessionOccupied', { sessionKey }),
        drainMailbox: sessionKey => { call('drainMailbox', { sessionKey }); },
      };
    },
  };
}

export function createMessageBus(deps: MessageBusDeps): MessageBus {
  const facade = messageBusFacade();
  let nextFence = 0;
  const fences = new Map<number, Promise<string>>();
  const callbacks = createCollaborationCallbacks((name, input) => {
    switch (name) {
      case 'bus.getMember': return deps.store.getMember(input.team, input.id, input.epoch ?? undefined);
      case 'bus.getMemberByName': return deps.store.getMemberByName(input.team, input.name, input.epoch ?? undefined);
      case 'bus.listMembersByTeam': return deps.store.listMembersByTeam(input.team, input.epoch ?? undefined);
      case 'bus.isEdgeAllowed': return deps.store.isEdgeAllowed(input.team, input.from, input.to, input.epoch ?? undefined);
      case 'bus.getTeamById': return deps.store.getTeamById(input.id);
      case 'bus.getEpochById': return deps.store.getEpochById(input.id);
      case 'bus.acquireRecipientFence': {
        const fence = deps.hooks.acquireRecipientFence!(input.target);
        if (typeof fence === 'string') return { kind: 'immediate', value: fence };
        const reference = ++nextFence; fences.set(reference, fence);
        return { kind: 'pending', reference };
      }
      case 'bus.awaitRecipientFence': return fences.get(input.reference)!.finally(() => fences.delete(input.reference));
      case 'bus.acceptRecipientFence': return deps.hooks.acceptRecipientFence?.(input.target, input.fence ?? undefined) ?? true;
      case 'bus.wakeTarget': return deps.hooks.wakeTarget(input as Parameters<typeof deps.hooks.wakeTarget>[0]);
      case 'bus.isBusy': return deps.hooks.isBusy(input.key);
      case 'bus.getTurnIdentity': return deps.hooks.getTurnIdentity?.(input.key);
      case 'bus.deliverMidTurn': return deps.hooks.deliverMidTurn?.(input as Parameters<NonNullable<typeof deps.hooks.deliverMidTurn>>[0]) ?? false;
      case 'bus.deliverRemote': {
        const { completionReference, ...request } = input;
        return deps.hooks.deliverRemote?.({ ...request, onCompletion: facade.remoteCompletion(completionReference) } as Parameters<NonNullable<typeof deps.hooks.deliverRemote>>[0]);
      }
      case 'bus.checkReachable': return deps.hooks.checkReachable?.(input.app, input.team) ?? true;
      case 'bus.deliverToCoordinator': return deps.hooks.deliverToCoordinator!(input as Parameters<NonNullable<typeof deps.hooks.deliverToCoordinator>>[0]);
      case 'bus.onMessage': return deps.onMessage?.(input as Parameters<NonNullable<typeof deps.onMessage>>[0]);
      case 'bus.recordActivity': return deps.recordActivity?.(input as Parameters<NonNullable<typeof deps.recordActivity>>[0]);
      default: return facade.dispatch(name, input);
    }
  });
  const handle = new (loadBinding().NativeMessageBus)(JSON.stringify({
    circuitOverrides: deps.circuitOverrides, syncWaitTimeoutMs: deps.syncWaitTimeoutMs, reservationTtlMs: deps.reservationTtlMs,
    acquireRecipientFence: !!deps.hooks.acquireRecipientFence, acceptRecipientFence: !!deps.hooks.acceptRecipientFence,
    deliverRemote: !!deps.hooks.deliverRemote, deliverToCoordinator: !!deps.hooks.deliverToCoordinator,
    onMessage: !!deps.onMessage, recordActivity: !!deps.recordActivity,
  }), callbacks.callback);
  return facade.bind(handle, callbacks);
}
