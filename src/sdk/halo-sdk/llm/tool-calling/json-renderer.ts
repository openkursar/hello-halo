/**
 * @module llm/tool-calling/json-renderer
 * Converts ToolDefinition[] into a system-prompt block using JSON code-fence
 * tool calling format.
 *
 * Format: the model outputs a JSON array inside a ```json code block.
 * This format is preferred for non-native-tool-calling models (GLM, DeepSeek,
 * Qwen, Kimi, MiniMax) where XML parsing proves unreliable.
 *
 * @license MIT
 */

import type { ToolDefinition } from '../../types/provider.js';
import { extractParams, type ParamInfo } from './tool-list-renderer.js';

// ---------------------------------------------------------------------------
// renderJsonToolsBlock
// ---------------------------------------------------------------------------

/**
 * Render an array of tool definitions into a plain-text block suitable for
 * injection into a system prompt, using JSON code-fence tool invocation format.
 *
 * The generated block describes:
 * - The JSON invocation format (```json code fence with array)
 * - Usage rules (required params only, boolean/number typing, etc.)
 * - Per-tool: name, description, parameters, and JSON usage example
 *
 * @param tools - Tool definitions to render.
 * @returns A formatted string to append to the system prompt.
 */
export function renderJsonToolsBlock(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';

  const lines: string[] = [
    'IMPORTANT: Format your tool calls as a JSON array inside a markdown code block.',
    'You may write explanatory text before the code block.',
    '',
    'Format:',
    '',
    '```json',
    '[{"name": "tool_name", "params": {"param1": "value1"}}]',
    '```',
    '',
    'Rules:',
    '- Always wrap tool calls in a ```json code block.',
    '- Output a JSON array, even for a single tool call.',
    '- Include ONLY required parameters from the tool\'s parameter list. Do NOT add optional parameters unless you need to set a non-default value.',
    '- Boolean parameters: use true/false (no quotes around the value).',
    '- Number parameters: use the numeric value directly (no quotes).',
    '- Write explanation/thinking in text BEFORE the code block.',
    '- Do NOT write anything after the closing ```.',
    '',
    'Example of a CORRECT tool call:',
    '',
    'I\'ll list the files in the current directory.',
    '',
    '```json',
    '[{"name": "Bash", "params": {"command": "ls"}}]',
    '```',
    '',
    'INCORRECT — do NOT do this (extra params, text after fence):',
    '',
    'I\'ll list files.',
    '',
    '```json',
    '[{"name": "Bash", "params": {"command": "ls", "description": "list"}}]',
    '```',
    'Done!  ← WRONG: nothing after the closing ```',
    '',
    'Here are the available tools:',
    '',
  ];

  for (const tool of tools) {
    lines.push(...renderOneTool(tool));
    lines.push('---');
    lines.push('');
  }

  // Remove trailing separator
  while (lines.length > 0 && (lines[lines.length - 1] === '' || lines[lines.length - 1] === '---')) {
    lines.pop();
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per-tool renderer
// ---------------------------------------------------------------------------

/**
 * Render a single tool definition with JSON usage example.
 */
function renderOneTool(tool: ToolDefinition): string[] {
  const schema = tool.input_schema as Record<string, unknown>;
  const params = extractParams(schema);
  const lines: string[] = [];

  // Tool header + description + parameters (same markdown format as XML)
  lines.push(`## ${tool.name}`);
  lines.push('');
  lines.push(`Description: ${tool.description}`);
  lines.push('');

  if (params.length > 0) {
    lines.push('Parameters:');
    for (const p of params) {
      const req = p.required ? 'required' : 'optional';
      const suffix = buildParamSuffix(p);
      lines.push(`- ${p.name}: (${req}) ${p.description}${suffix}`);
    }
    lines.push('');
  } else {
    lines.push('Parameters: none');
    lines.push('');
  }

  // JSON-specific Usage section
  const required = params.filter(p => p.required);
  const optional = params.filter(p => !p.required);
  lines.push('Usage:');
  const usageObj = buildUsageObject(tool.name, required);
  lines.push('```json');
  lines.push(JSON.stringify([usageObj], null, 2));
  lines.push('```');
  if (optional.length > 0) {
    const optionalNames = optional.map(p => p.name).join(', ');
    lines.push(`(Optional parameters: ${optionalNames} — omit unless needed)`);
  }
  lines.push('');

  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a one-line description suffix for enum / default constraints. */
function buildParamSuffix(param: ParamInfo): string {
  const parts: string[] = [];
  if (param.enumValues && param.enumValues.length > 0) {
    parts.push(`Allowed values: ${param.enumValues.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (param.defaultValue !== undefined) {
    parts.push(`Default: ${JSON.stringify(param.defaultValue)}`);
  }
  return parts.length > 0 ? ` ${parts.join('. ')}` : '';
}

/** Build a JSON usage object for a single tool call. */
function buildUsageObject(
  toolName: string,
  requiredParams: ParamInfo[],
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const p of requiredParams) {
    // Use a type-appropriate placeholder for the usage example
    if (p.type === 'boolean') {
      params[p.name] = true;
    } else if (p.type === 'number' || p.type === 'integer') {
      params[p.name] = 42;
    } else if (p.type === 'array') {
      params[p.name] = [];
    } else if (p.type === 'object') {
      params[p.name] = {};
    } else {
      params[p.name] = 'value';
    }
  }
  return { name: toolName, params };
}
