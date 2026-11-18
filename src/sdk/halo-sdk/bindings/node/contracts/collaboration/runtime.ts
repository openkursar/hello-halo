import type { TeamEnvelope,TeamRequestOrigin,TeamTriggerContext } from "../../collaboration/protocol.js";
import type { BlackboardFinding,BlackboardTask,TeamActivity } from "../../collaboration/records.js";
import type { CollaborationServer } from "../../collaboration/types.js";
import type { BlackboardWriteStore } from "./board-writes.js";
import type { TeamDelivery,TurnCompletion } from "./message-bus.js";
export interface CollaborationMember {
    id: string;
    name: string;
    parentId: string;
    prompt: string;
    cwd?: string;
    isolation?: 'worktree';
    origin?: TeamRequestOrigin;
    createdAt: number;
    state?: 'idle' | 'queued' | 'running' | 'stopped' | 'error';
    model?: string;
    workingDirectory?: string;
    worktreePath?: string;
}
export interface MemberExecutionRequest {
    member: CollaborationMember;
    deliveries: readonly TeamDelivery[];
    signal: AbortSignal;
    server: CollaborationServer;
    ready(): void;
}
export interface CollaborationExecutor {
    execute(request: MemberExecutionRequest): Promise<TurnCompletion>;
    inject(memberId: string, deliveries: readonly TeamDelivery[]): boolean;
    interrupt(memberId: string): Promise<boolean>;
    release(memberId: string): Promise<void>;
    readMember(memberId: string, before?: number): Promise<string>;
    readArtifact(ref: string, requesterId: string): Promise<string>;
    validateArtifact(ref: string, producerId: string): Promise<string>;
}
export interface CollaborationScopeStore extends BlackboardWriteStore {
    readonly teamId: string;
    readonly epochId: string;
    getMember(id: string): CollaborationMember | undefined;
    findMember(name: string): CollaborationMember | undefined;
    members(): readonly CollaborationMember[];
    addMember(member: CollaborationMember): void;
    removeMember(id: string): void;
    tasks(): readonly BlackboardTask[];
    findings(): readonly BlackboardFinding[];
    activities(): readonly TeamActivity[];
    flush(): Promise<void>;
}
export interface CollaborationRuntimeOptions {
    store: CollaborationScopeStore;
    executor: CollaborationExecutor;
    deliverToSource(envelope: TeamEnvelope, trigger: TeamTriggerContext): Promise<'dispatched' | 'mid_turn' | 'buffered'>;
    maxConcurrentTurns: number;
    maxMembers: number;
    idleTimeoutMs?: number;
    origin?: TeamRequestOrigin;
    onChange?: () => void;
}
