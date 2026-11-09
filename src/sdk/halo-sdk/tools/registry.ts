/**
 * @module tools/registry
 * Tool registry — instantiation, filtering, and lookup.
 * @license MIT
 */

import type { Tool } from '../types/tool.js';

// ---------------------------------------------------------------------------
// Tool imports — each tool module exports a Tool constant or class instance
// ---------------------------------------------------------------------------

import { BashTool } from './bash/index.js';
import { ReadTool } from './read/index.js';
import { WriteTool } from './write/index.js';
import { EditTool } from './edit/index.js';
import { GrepTool } from './grep/index.js';
import { GlobTool } from './glob/index.js';
import { WebFetchTool } from './web-fetch/index.js';
import { SkillTool } from './skill/index.js';
import { TodoWriteTool } from './todo-write/index.js';
import { GoalTool } from './goal/index.js';
import { AskUserQuestionTool } from './ask-user/index.js';
import { TaskStopTool, TaskOutputTool } from './task/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely instantiate: if the export is a class (constructor), create an
 *  instance; if it is already an object satisfying Tool, use it directly. */
function ensureTool(exported: any): Tool {
  if (typeof exported === 'function') {
    return new exported();
  }
  return exported as Tool;
}

// ---------------------------------------------------------------------------
// getAllTools
// ---------------------------------------------------------------------------

/**
 * Instantiate all built-in tools and return them as an array.
 * Tools that are classes are instantiated; tools that are plain objects
 * (satisfying the Tool interface) are used directly.
 */
export function getAllTools(): Tool[] {
  return [
    // File operations
    ensureTool(ReadTool),
    ensureTool(WriteTool),
    ensureTool(EditTool),
    ensureTool(GlobTool),
    ensureTool(GrepTool),

    // Shell
    ensureTool(BashTool),

    // Web
    ensureTool(WebFetchTool),

    // Skills
    ensureTool(SkillTool),

    // Planning & progress
    ensureTool(GoalTool),
    ensureTool(TodoWriteTool),

    // Background shell tasks
    ensureTool(TaskStopTool),
    ensureTool(TaskOutputTool),

    // Communication
    ensureTool(AskUserQuestionTool),


  ];
}

// ---------------------------------------------------------------------------
// filterTools
// ---------------------------------------------------------------------------

/**
 * Filter a tool list by allowedTools / disallowedTools.
 *
 * - If `allowedTools` is provided, only tools whose name appears in the list
 *   are kept. This tool-pool filter is independent of Options.allowedTools,
 *   which supplies permission preapprovals.
 * - If `disallowedTools` is provided, tools whose name appears in the list are removed.
 * - If both are provided, allowedTools is applied first, then disallowedTools.
 */
export function filterTools(
  allTools: Tool[],
  opts?: {
    allowedTools?: string[];
    disallowedTools?: string[];
  },
): Tool[] {
  let tools = allTools;

  if (opts?.allowedTools && opts.allowedTools.length > 0) {
    const allowed = new Set(opts.allowedTools);
    tools = tools.filter((t) => allowed.has(t.name));
  }

  if (opts?.disallowedTools && opts.disallowedTools.length > 0) {
    const disallowed = new Set(opts.disallowedTools);
    tools = tools.filter((t) => !disallowed.has(t.name));
  }

  return tools;
}

// ---------------------------------------------------------------------------
// findToolByName
// ---------------------------------------------------------------------------

/**
 * Find a tool by name in a tool array.
 * Returns undefined if not found.
 */
export function findToolByName(
  tools: Tool[],
  name: string,
): Tool | undefined {
  return tools.find((t) => t.name === name);
}
