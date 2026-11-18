import type { BlackboardFinding,BlackboardTask,TeamActivity } from "../../collaboration/records.js";
import type { CollaborationMember } from "./runtime.js";
export type CollaborationMutation = {
    kind: 'member';
    value: CollaborationMember;
} | {
    kind: 'remove_member';
    id: string;
} | {
    kind: 'task';
    value: BlackboardTask;
} | {
    kind: 'finding';
    value: BlackboardFinding;
} | {
    kind: 'activity';
    value: TeamActivity;
};
export interface MemoryScopeStoreOptions {
    teamId: string;
    epochId: string;
    maxRecords?: number;
    maxBytes?: number;
    persist?: (mutations: readonly CollaborationMutation[]) => Promise<void>;
}
