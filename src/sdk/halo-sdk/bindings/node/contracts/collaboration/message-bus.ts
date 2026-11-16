import type { MessageBusStore } from "../../collaboration/message-store.js";
import type { CollabMode,TeamEnvelope,TeamRequestOrigin,TeamSendAsyncResult,TeamSendSyncResult,TeamTriggerContext } from "../../collaboration/protocol.js";
import type { PostActivityInput } from "./board-writes.js";
import type { BusyDisposition,DeliverDisposition } from "./turn-gate.js";
export type CoordinatorDisposition = Extract<DeliverDisposition, 'dispatched' | 'mid_turn' | 'buffered'>;
export interface TeamDeliveryHooks {
    acquireRecipientFence?(target: {
        teamId: string;
        epochId: string;
        appId: string;
        fromAppId: string | null;
        requestId?: string;
    }): string | Promise<string>;
    acceptRecipientFence?(target: {
        teamId: string;
        epochId: string;
        appId: string;
    }, fence?: string): boolean;
    wakeTarget(params: {
        sessionKey: string;
        appId: string;
        teamId: string;
        epochId: string;
        envelope: TeamEnvelope;
        trigger: TeamTriggerContext;
        deliveries?: readonly TeamDelivery[];
    }): Promise<void>;
    isBusy(sessionKey: string): boolean;
    getTurnIdentity?(sessionKey: string): string | undefined;
    deliverMidTurn?(params: {
        sessionKey: string;
        appId: string;
        teamId: string;
        epochId: string;
        envelope: TeamEnvelope;
        trigger: TeamTriggerContext;
        deliveries?: readonly TeamDelivery[];
    }): boolean;
    deliverRemote?(params: {
        sessionKey: string;
        envelope: TeamEnvelope;
        trigger: TeamTriggerContext;
        coalescingKey?: string;
        onCompletion: (outcome: TurnCompletion) => void;
    }): boolean | undefined;
    checkReachable?(appId: string, teamId: string): boolean;
    deliverToCoordinator?(params: {
        envelope: TeamEnvelope;
        trigger: TeamTriggerContext;
        coalescingKey?: string;
    }): Promise<CoordinatorDisposition>;
}
export type TurnCompletion = {
    kind: 'result';
    content: string;
    taskId?: string;
    stopReason?: string;
} | {
    kind: 'escalation';
    content: string;
} | {
    kind: 'error';
    message: string;
} | {
    kind: 'timeout';
} | {
    kind: 'undelivered';
    reason: string;
};
export type CircuitBreachReason = 'maxMessages' | 'maxForwardDepth' | 'turnReportFlood';
export interface CircuitLimits {
    maxMessages: number;
    maxForwardDepth: number;
}
export interface EpochStats {
    messageCount: number;
    maxForwardDepthSeen: number;
    firstSendAt: number | null;
    breached: boolean;
    breachReason: CircuitBreachReason | null;
}
export interface CircuitBreachEvent {
    teamId: string;
    epochId: string;
    reason: CircuitBreachReason;
    limits: CircuitLimits;
    stats: EpochStats;
}
export interface SendInput {
    requestId?: string;
    teamId: string;
    epochId: string;
    fromAppId: string | null;
    to: string;
    message: string;
    wait?: boolean;
    forwardDepth?: number;
    origin?: TeamRequestOrigin;
    taskRef?: string;
}
export type { BusyDisposition };
export type WakeDisposition = DeliverDisposition | 'remote_accepted';
export interface MessageBus {
    send(input: SendInput): Promise<TeamSendAsyncResult | TeamSendSyncResult>;
    deliverRuntimeWake(params: {
        envelope: TeamEnvelope;
        trigger: TeamTriggerContext;
        onBusy: BusyDisposition;
        coalescingKey?: string;
    }): Promise<WakeDisposition>;
    notifySessionReady(sessionKey: string): void;
    holdSession(sessionKey: string): TeamDelivery[];
    cancelSession(sessionKey: string): void;
    continueSession(sessionKey: string): void;
    returnDeliveries(sessionKey: string, deliveries: readonly TeamDelivery[]): void;
    returnHeldBack(sessionKey: string, deliveries: readonly TeamDelivery[]): TeamDelivery[];
    runRelayedTurn<T>(params: {
        sessionKey: string;
        run: () => Promise<T>;
    }): Promise<T>;
    completeTurn(params: {
        sessionKey: string;
        trigger: TeamTriggerContext;
        outcome: TurnCompletion;
        sealPending?: boolean;
    }): void;
    assertCanContact(teamId: string, fromAppId: string, toAppId: string, collabMode: CollabMode, epochId?: string): void;
    resolveMemberAppId(teamId: string, memberName: string, epochId?: string): string;
    resolvePendingWaitsForMember(appId: string, outcome: TurnCompletion): number;
    getEpochStats(epochId: string): EpochStats;
    resetEpoch(epochId: string): void;
    resetCircuit(epochId: string): void;
    tripExternal(teamId: string, epochId: string, reason: CircuitBreachReason): void;
    onBreach(listener: (event: CircuitBreachEvent) => void): () => void;
    getPendingRecordedInputIds(sessionKey: string): readonly string[];
    hasBufferedMessages(epochId: string): boolean;
    isSessionOccupied(sessionKey: string): boolean;
    drainMailbox(sessionKey: string): void;
}
export type TeamMessageEvent = {
    teamId: string;
    epochId: string;
    fromAppId: string;
    toAppId: string;
    fromMemberName: string;
    toMemberName: string;
    messageId: string;
    ts: number;
};
export interface MessageBusDeps {
    store: MessageBusStore;
    hooks: TeamDeliveryHooks;
    trace?: (message: string) => void;
    onMessage?: (event: TeamMessageEvent) => void;
    circuitOverrides?: Partial<CircuitLimits>;
    syncWaitTimeoutMs?: number;
    reservationTtlMs?: number;
    recordActivity?: (input: PostActivityInput) => void;
}
export interface TeamDelivery {
    envelope: TeamEnvelope;
    trigger: TeamTriggerContext;
    inputRecorded?: boolean;
    recordedInputIds?: readonly string[];
    admissionGeneration?: number;
}
