/**
 * @module tools/goal
 * GoalTool — the model sets and maintains the session goal.
 *
 * The goal lives outside the message history (see ./store.ts), so it
 * survives compaction; the loop re-injects it and consults it at the end of
 * each turn. Each call echoes the resulting goal so it sits at the context tail.
 * @license MIT
 */

import type { Tool, ToolContext, ToolResult } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import type { Goal, GoalStatus } from '../../types/goal.js';
import { renderGoal } from '../../core/goal-reminders.js';
import { GOAL_TOOL_NAME, GOAL_TOOL_DESCRIPTION, GOAL_TOOL_INPUT_SCHEMA } from './schema.js';
import { applyAgentGoal, cleanCriteria, getActiveGoal } from './store.js';

export {
  getGoal,
  captureGoalState,
  restoreGoalState,
  type GoalEntry,
  getActiveGoal,
  setGoalFromHost,
  drainGoalChange,
  releaseGoal,
  sameGoal,
  type GoalChange,
} from './store.js';
export { GOAL_TOOL_NAME } from './schema.js';

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finish(goal: Goal, status: GoalStatus, note: string | undefined): Goal {
  return {
    ...goal,
    status,
    note,
    updatedBy: 'agent',
    updatedAt: new Date().toISOString(),
  };
}

export const GoalTool: Tool = {
  name: GOAL_TOOL_NAME,
  description: GOAL_TOOL_DESCRIPTION,
  inputSchema: GOAL_TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
  permissionLevel: 'none',

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = input.action;
    const note = optionalText(input.note);
    const active = getActiveGoal(ctx.sessionId);

    switch (action) {
      case 'set': {
        const objective = optionalText(input.objective);
        if (!objective) return toolError('set requires a non-empty objective.');
        const goal: Goal = {
          objective,
          doneWhen: cleanCriteria(input.doneWhen),
          status: 'active',
          note,
          updatedBy: 'agent',
          updatedAt: new Date().toISOString(),
        };
        applyAgentGoal(ctx.sessionId, goal);
        const replaced = active ? `\nReplaced the previous goal: ${active.objective}` : '';
        return toolSuccess(`Goal set.\n${renderGoal(goal)}${replaced}`);
      }

      case 'update': {
        if (!active) return toolError('There is no active goal to update. Use set to create one.');
        const objective = optionalText(input.objective) ?? active.objective;
        const doneWhen = input.doneWhen === undefined ? active.doneWhen : cleanCriteria(input.doneWhen);
        const goal: Goal = {
          ...active,
          objective,
          doneWhen,
          note: note ?? active.note,
          updatedBy: 'agent',
          updatedAt: new Date().toISOString(),
        };
        applyAgentGoal(ctx.sessionId, goal);
        return toolSuccess(`Goal updated.\n${renderGoal(goal)}`);
      }

      case 'complete': {
        if (!active) return toolError('There is no active goal to complete.');
        const goal = finish(active, 'complete', note);
        applyAgentGoal(ctx.sessionId, goal);
        return toolSuccess(`Goal marked complete.\n${renderGoal(goal)}`);
      }

      case 'abandon': {
        if (!active) return toolError('There is no active goal to abandon.');
        const goal = finish(active, 'abandoned', note);
        applyAgentGoal(ctx.sessionId, goal);
        return toolSuccess(`Goal abandoned.\n${renderGoal(goal)}`);
      }

      default:
        return toolError('action must be one of: set, update, complete, abandon.');
    }
  },
};
