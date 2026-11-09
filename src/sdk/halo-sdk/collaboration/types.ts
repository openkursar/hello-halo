export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'rejected' | 'blocked';

export interface SpawnInput {
  prompt: string;
  name?: string;
  cwd?: string;
  isolation?: 'worktree';
}

export interface CollaborationInputs {
  spawn_agent: SpawnInput;
  team_send: { to: string; message: string };
  team_read_board: { mine?: boolean; status?: TaskStatus };
  team_read_member: { member: string; before?: number };
  team_post_finding: { content?: string; ref?: string };
  team_read_artifact: { ref: string };
  team_post_task: { title: string; assignee: string; parentId?: string };
  team_update_task: { taskId: string; status: TaskStatus; resultRef?: string; note?: string };
  team_stop: { to: string };
}

export type CollaborationToolName = keyof CollaborationInputs;

export interface CollaborationResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface CollaborationCallContext {
  signal?: AbortSignal;
}

/** Operations are bound to a trusted scope and caller before tools are created. */
export type CollaborationOperations = {
  [K in CollaborationToolName]?: (
    input: CollaborationInputs[K],
    context: CollaborationCallContext,
  ) => Promise<CollaborationResult>;
};

export interface CollaborationToolDescriptor {
  name: CollaborationToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean };
}

export interface CollaborationServer {
  type: 'sdk';
  name: string;
  instance: {
    readonly name: string;
    readonly version: string;
    listTools(): CollaborationToolDescriptor[];
    callTool(
      name: string,
      input: Record<string, unknown>,
      context?: CollaborationCallContext,
    ): Promise<CollaborationResult | undefined>;
  };
}
