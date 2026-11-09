/**
 * @module tools/todo-write/schema
 * TodoWrite tool schema and configuration.
 * @license MIT
 */

export const TODO_WRITE_TOOL_NAME = 'TodoWrite';

export const TODO_WRITE_TOOL_DESCRIPTION = `Keep a visible checklist for the current work. The user sees it as a live progress panel, and it keeps you organized across many steps.

When to use it
- The work has three or more distinct steps, or needs planning before you start.
- The user gives you several things to do at once.
- The task will run long enough that seeing progress helps the user.
- New requirements arrive mid-task — add them so nothing gets dropped.

When not to use it
- Greetings, questions, and conversation ("hi", "what does this function do?").
- A single step, or a few trivial ones you can simply do ("rename this file", "fix this typo").
In these cases just do the work; a checklist only adds noise.

Keeping it accurate
- Write each item as a concrete outcome ("Draft the pricing section", "Fix the failing login test"), not a vague activity. Give each item a content in imperative form ("Run tests") and an activeForm shown while it's in progress ("Running tests").
- Mark an item in_progress right before you start it and completed right after it's truly done. Update as you go rather than batching updates at the end. Normally only one item is in progress at a time.
- Completed means done — not partly done, not with its checks still failing. If you're blocked, leave the item in progress and add one for whatever is blocking it.
- The list is a plan, not a contract. When what you learn changes the best path — a step turns out unnecessary, a new one is needed, the order should change — update the list right away, drop items that no longer apply, and briefly tell the user why.
- If a goal is set, the items should serve it; when the two disagree, follow the goal.

Examples
- "Compare these three vendors and write a recommendation" → gather each vendor's pricing and terms; compare them on the user's criteria; draft the recommendation; check the figures against the sources.
- "Add dark mode and make sure the build passes" → add the toggle; add theme styles; update components; run the build and tests (included because the user asked for it).
- "hi" or "what does git status do?" → no list; just answer.`;

export const TODO_WRITE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The task to complete, written in imperative form',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
          },
          activeForm: {
            type: 'string',
            description: 'The same task in present continuous form, displayed while in progress',
          },
        },
        required: ['content', 'status', 'activeForm'],
      },
      description: 'The updated todo list',
    },
  },
  required: ['todos'],
} as const;
