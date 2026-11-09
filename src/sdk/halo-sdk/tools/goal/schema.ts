/**
 * @module tools/goal/schema
 * Goal tool schema and description.
 * @license MIT
 */

export const GOAL_TOOL_NAME = 'Goal';

export const GOAL_TOOL_DESCRIPTION = `Set a goal that holds for the whole task: what the work must achieve and how to tell it's done. Unlike the conversation, the goal is never summarized away — it survives context compaction intact — and the user can see and edit it.

When to use it
- The user asks you to set or work toward a goal.
- The task is clearly long and complex — likely to run for hours, span many rounds of work, or outlast a context compaction — so it would be easy to lose sight of the objective.
For ordinary multi-step work, TodoWrite alone is enough.

Actions
- set: state the objective in the user's terms, with done-when criteria concrete enough to check.
- update: refine the wording or criteria as your understanding improves. If the change alters what the user actually wants, confirm with them first.
- complete: only after checking the real result against every criterion.
- abandon: when the user cancels the goal or replaces it with a different one.

Working with a goal
- The goal is the direction; the route can change. Revising your todos and approach as you learn is expected. If you notice you're working on something that doesn't serve the goal, step back and re-plan.
- If the user edits or removes the goal, you'll be told; follow the latest version.
- Before ending work on an open goal, check the result against the criteria. If some aren't met, keep going, or report which ones and why.

Examples

<example>
User: Migrate this project from JavaScript to TypeScript. It's big — take the night if you need to.
Goal: set
  objective: Migrate the project from JavaScript to TypeScript
  doneWhen:
    - No .js source files remain under src/
    - tsc --noEmit passes with strict mode on
    - The existing test suite passes
Then: TodoWrite for the first batch of modules.
Why: hours of work across hundreds of files will outlast several compactions. The criteria can be checked by commands, not by impression.
</example>

<example>
User: Go through last year's 40 supplier invoices and reconcile them against the bank export. Flag anything that doesn't match.
Goal: set
  objective: Reconcile all 40 of last year's supplier invoices against the bank export
  doneWhen:
    - Every invoice is marked matched or flagged
    - Each flagged item states the amount difference and the likely cause
    - A summary table is saved next to the source files
Why: long, repetitive work where it's easy to lose count. "Looks right" would not be checkable; "every invoice marked" is.
</example>

<example>
User: Set a goal: get the landing page conversion copy ready for Monday's launch.
Goal: set
  objective: Landing page copy ready for Monday's launch
  doneWhen:
    - Headline, subhead, three feature blocks, and CTA written
    - Two headline variants provided for A/B testing
Why: the user asked for a goal explicitly, so set one even though the task is moderate.
</example>

<example>
User: Add a dark mode toggle to settings and make sure the build passes.
No goal. Use TodoWrite.
Why: a few steps finished within one sitting; a checklist covers it.
</example>

<example>
User: What's the difference between a mutex and a semaphore?
No goal, no todo. Just answer.
</example>

<example>
Mid-task on the TypeScript migration, you find the user's team plans to delete half the legacy modules next week.
Don't silently change the goal. Ask whether those modules should be excluded, then use update if they confirm.
Why: this changes what the user wants, not just how you get there.
</example>`;

export const GOAL_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['set', 'update', 'complete', 'abandon'],
      description: 'What to do with the goal',
    },
    objective: {
      type: 'string',
      description: 'What the work must achieve, in the user\'s terms. Required for set.',
    },
    doneWhen: {
      type: 'array',
      items: { type: 'string' },
      description: 'Checkable criteria that together mean the objective is met. For update, replaces the current list.',
    },
    note: {
      type: 'string',
      description: 'Optional context for this change, e.g. what was verified on complete or why it was abandoned.',
    },
  },
  required: ['action'],
} as const;
