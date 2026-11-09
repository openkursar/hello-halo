import type { PromptProfileId, PromptProfileSelection } from '../../types/config.js';

export interface PromptProfile {
  readonly id: PromptProfileId;
  readonly version: number;
  readonly conversationGuidance: string;
  readonly summaryGuidance: string;
}

const profiles: Readonly<Record<PromptProfileId, PromptProfile>> = Object.freeze({
  default: Object.freeze({
    id: 'default',
    version: 1,
    conversationGuidance: '',
    summaryGuidance: '',
  }),
  explicit: Object.freeze({
    id: 'explicit',
    version: 1,
    conversationGuidance: `# Execution checkpoints
- Choose the next action from the current request and the evidence already available. A plan describes future work; it does not mean the work happened.
- Before a tool call, check its required arguments and whether an earlier result is needed. After it returns, use the result to decide what to do next.
- When an operation fails, identify the failed condition before trying again. A changed command is useful only when it addresses that condition.
- Before finishing, compare the delivered result with the user's requested outcome. Report any remaining gap and the evidence for what succeeded.`,
    summaryGuidance: 'Put unresolved work and the latest user constraints before the record of completed work. Keep identifiers and values exact when the next action depends on them. Separate confirmed results from proposed actions.',
  }),
});

/** Exact wire IDs keep gateway aliases explicit; an unknown model uses the default. */
export function resolvePromptProfile(
  model: string,
  selection?: PromptProfileSelection,
): PromptProfile {
  let id: PromptProfileId = 'default';
  if (typeof selection === 'string') {
    id = selection;
  } else if (selection) {
    id = selection.models && Object.prototype.hasOwnProperty.call(selection.models, model)
      ? selection.models[model]
      : selection.default ?? 'default';
  }
  if (!Object.prototype.hasOwnProperty.call(profiles, id)) {
    throw new RangeError(`Unknown prompt profile: ${String(id)}`);
  }
  return profiles[id];
}
