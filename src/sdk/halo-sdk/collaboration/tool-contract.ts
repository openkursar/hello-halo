import type { CollaborationInputs, CollaborationToolDescriptor, CollaborationToolName } from './types.js';

interface Field {
  type: 'string' | 'boolean' | 'integer';
  description: string;
  optional?: boolean;
  values?: readonly string[];
  minimum?: number;
  maximum?: number;
}

interface Definition {
  description: string;
  fields: Record<string, Field>;
  readOnly?: boolean;
}

const text = (description: string, optional = false): Field => ({ type: 'string', description, optional });
const statuses = ['pending', 'in_progress', 'done', 'rejected', 'blocked'] as const;

const definitions: Record<CollaborationToolName, Definition> = {
  spawn_agent: {
    description: 'Create a collaborator in your current work context and give it its first assignment. Returns promptly; the collaborator works independently. It does not see your conversation history. Include relevant context, limits and the expected result. You can message it again with team_send and create more collaborators as needed. No team setup or shared goal is required.',
    fields: {
      prompt: text('Self-contained assignment, relevant inputs, permitted actions and expected evidence.'),
      name: text('Optional short name for this collaborator. The result gives its unique addressing handle.', true),
      cwd: text('Optional working directory within the host-authorized workspace. Cannot be combined with isolation.', true),
      isolation: { ...text('Optional separate Git worktree. Only supported when the host provides workspace isolation.', true), values: ['worktree'] },
    },
  },
  team_send: {
    description: 'Send a request, additional instruction, question or reply to a collaborator in the current work context. A working recipient receives compatible messages at its next step; an idle recipient can resume. Returns delivery status, not task completion. Reply to the teammate who requested your work. Share large outputs as published artifact references rather than copying them into messages.',
    fields: { to: text('Recipient address from the message, creation receipt or board. Use "lead" for the lead of this work.'), message: text('Self-contained message for the recipient.') },
  },
  team_read_board: {
    description: 'Read the current collaboration: members, availability, tasks, shared findings and recent activity. Use it to recover context or check facts, not for repeated progress polling. A partial response is explicitly marked. File paths on another machine must be read through team_read_artifact.',
    fields: {
      mine: { type: 'boolean', description: 'Only tasks assigned to you.', optional: true },
      status: { ...text('Only tasks with this status.', true), values: statuses },
    },
    readOnly: true,
  },
  team_read_member: {
    description: 'Read an authorized collaborator record in this work context to verify a report or understand a problem. Reads messages, not private reasoning. Results are paginated; use the returned before value for older messages. An unreachable record is reported as unavailable, not empty.',
    fields: {
      member: text('Collaborator handle.'),
      before: { type: 'integer', minimum: 1, optional: true, description: 'Read messages before the sequence returned on the previous page.' },
    },
    readOnly: true,
  },
  team_post_finding: {
    description: 'Publish a durable fact, constraint, conclusion or artifact useful to multiple collaborators. Do not use this for assignments, questions, requests, replies, acknowledgements or routine progress; use team_send for those. Publication does not notify a specific person or require a reply. Usually unnecessary when only one collaborator is helping. Supply content, a published file reference, or both.',
    fields: { content: text('Reusable knowledge for other collaborators.', true), ref: text('Existing artifact to publish, within the authorized workspace.', true) },
  },
  team_read_artifact: {
    description: 'Read a published collaboration artifact, including one produced on another machine. Use a reference from the board or a teammate. The host checks publication and access; an unavailable artifact is not an empty file.',
    fields: { ref: text('Published artifact reference.') },
    readOnly: true,
  },
  team_post_task: {
    description: 'Record a task and its assignee on the shared board when explicit tracking is useful. This does not notify or start the assignee: send the assignment with team_send. Simple questions and small requests need no board task.',
    fields: { title: text('Clear task title.'), assignee: text('Collaborator handle.'), parentId: text('Optional parent board task.', true) },
  },
  team_update_task: {
    description: 'Update a board task with its actual status, result or blocker. Mark done only when the required work is supported by evidence. Publishing a result does not replace a reply to the requesting teammate.',
    fields: {
      taskId: text('Board task identifier.'),
      status: { ...text('New task status.'), values: statuses },
      resultRef: text('Existing artifact produced by this task.', true),
      note: text('Outcome, evidence or blocker.', true),
    },
  },
  team_stop: {
    description: 'Stop a collaborator execution you are authorized to control in the current work context. Use to="all" to stop the current collaboration. This does not mark work complete, delete history or undo external effects. The result distinguishes a confirmed stop, no running work and an unconfirmed stop.',
    fields: { to: text('Collaborator handle, or "all" for the current collaboration. Never another team or conversation.') },
  },
};

export const COLLABORATION_TOOL_NAMES = Object.freeze(Object.keys(definitions) as CollaborationToolName[]);

export function describeCollaborationTool(name: CollaborationToolName): CollaborationToolDescriptor {
  const definition = definitions[name];
  const properties = Object.fromEntries(Object.entries(definition.fields).map(([key, field]) => [key, {
    type: field.type,
    description: field.description,
    ...(field.values ? { enum: [...field.values] } : {}),
    ...(field.type === 'string' ? { minLength: 1 } : {}),
    ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
    ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
  }]));
  const inputSchema: Record<string, unknown> = {
    type: 'object', properties, additionalProperties: false,
    required: Object.entries(definition.fields).filter(([, field]) => !field.optional).map(([key]) => key),
  };
  return { name, description: definition.description, inputSchema, annotations: { readOnlyHint: definition.readOnly === true } };
}

export function parseCollaborationInput<K extends CollaborationToolName>(name: K, input: unknown): CollaborationInputs[K] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Arguments must be an object.');
  const definition = definitions[name];
  const supplied = input as Record<string, unknown>;
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(definition.fields, key)) throw new TypeError(`Unexpected argument: ${key}.`);
  }
  const parsed: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(definition.fields)) {
    const value = Object.hasOwn(supplied, key) ? supplied[key] : undefined;
    if (value === undefined && field.optional) continue;
    if (field.type === 'string' && (typeof value !== 'string' || !value.trim())) throw new TypeError(`${key} must be a non-empty string.`);
    if (field.type === 'boolean' && typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
    if (field.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value)
      || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) {
      throw new TypeError(`${key} must be an integer within its allowed range.`);
    }
    if (field.values && !field.values.includes(value as string)) throw new TypeError(`${key} is not an allowed value.`);
    parsed[key] = value;
  }
  if (name === 'spawn_agent' && parsed.cwd !== undefined && parsed.isolation !== undefined) throw new TypeError('cwd and isolation cannot be combined.');
  if (name === 'team_post_finding' && parsed.content === undefined && parsed.ref === undefined) throw new TypeError('Supply content or ref.');
  return parsed as unknown as CollaborationInputs[K];
}
