import type { BlackboardFinding,BlackboardTask,TeamActivity,TeamActivityKind,TeamActivityStatus } from "../../collaboration/records.js";
import type { TaskStatus } from "../../collaboration/types.js";
export interface PostTaskInput {
    teamId: string;
    epochId: string;
    callerAppId: string;
    title: string;
    assigneeAppId: string | null;
    parentId?: string;
}
export interface UpdateTaskInput {
    teamId: string;
    epochId: string;
    taskId: string;
    status: TaskStatus;
    resultRef?: string;
    note?: string;
    callerAppId?: string;
}
export interface PostFindingInput {
    teamId: string;
    epochId: string;
    callerAppId: string;
    content?: string;
    ref?: string;
}
export type PublishedRefClaim = {
    kind: 'finding';
    authorAppId: string;
} | {
    kind: 'task';
    taskId: string;
};
export interface PublishedRefConflict {
    memberName: string;
}
export interface PostActivityInput {
    teamId: string;
    epochId: string;
    kind: TeamActivityKind;
    actorAppId: string;
    targetAppId?: string | null;
    subject: string;
    body?: string | null;
    refId?: string | null;
    correlationId?: string | null;
    status?: TeamActivityStatus | null;
    id?: string;
}
export interface BlackboardWriteRecord {
    teamId: string;
    epochId: string;
    op: 'post_task' | 'update_task' | 'post_finding' | 'post_activity' | 'epoch_upsert' | 'member_profile' | 'participant_upsert' | 'check_upsert' | 'check_delete';
    payload: Record<string, unknown>;
    taskId?: string;
}
export interface BlackboardWriteStore {
    insertTask(task: BlackboardTask): void;
    getTaskById(id: string): BlackboardTask | null;
    updateTask(id: string, patch: Partial<Pick<BlackboardTask, 'status' | 'resultRef' | 'note'>>, now: number): void;
    insertFinding(finding: BlackboardFinding): void;
    insertActivity(activity: TeamActivity): void;
}
export type BlackboardChange = {
    teamId: string;
    epochId: string;
} & ({
    kind: 'task';
    task: BlackboardTask;
} | {
    kind: 'finding';
    finding: BlackboardFinding;
} | {
    kind: 'activity';
    activity: TeamActivity;
});
export interface BlackboardWriterOptions {
    store: BlackboardWriteStore;
    onChange?: (change: BlackboardChange) => void;
    onWrite?: (record: BlackboardWriteRecord) => void;
    clock?: () => number;
    createId?: () => string;
}
export declare function createBlackboardWriter(options: BlackboardWriterOptions): {
    postTask: (input: PostTaskInput) => {
        taskId: string;
    };
    updateTask: (input: UpdateTaskInput) => void;
    postFinding: (input: PostFindingInput) => {
        findingId: string;
    };
    postActivity: (input: PostActivityInput) => {
        activityId: string;
    };
};
