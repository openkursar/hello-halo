/**
 * @module llm/tool-calling/xml-renderer
 * Renders tool descriptions and the XML invocation format for models
 * without native function calling.
 *
 * Invocations use self-describing `<param>` tags: the parameter name, type,
 * and required flag are attributes on the tag itself rather than encoded in
 * the tag name, which keeps parsing robust when a value contains markup.
 *
 * Example output for a Bash tool:
 *
 *   ## Bash
 *   Description: Execute a shell command.
 *   Parameters:
 *   - command: (required) The command to execute
 *   Usage:
 *   <Bash>
 *   <param name="command" type="string" required="true">value</param>
 *   </Bash>
 *
 * This format is preferred for non-native-tool-calling models (DeepSeek,
 * Qwen, Kimi, MiniMax) because it standardises the parameter tag to `<param>`
 * with explicit name/type/required attributes, reducing the model's need to
 * synthesise arbitrary tag names.
 *
 * @license MIT
 */

import type { ToolDefinition } from '../../types/provider.js';
import { extractParams, type ParamInfo } from './tool-list-renderer.js';

// ---------------------------------------------------------------------------
// renderToolsBlock
// ---------------------------------------------------------------------------

/**
 * Render an array of tool definitions into a plain-text block suitable for
 * injection into a system prompt, using BFCL-style XML tool invocation format.
 *
 * The generated block describes:
 * - The BFCL XML invocation format (`<tool><param name="p">v</param></tool>`)
 * - Usage rules (required params only, boolean/number typing, etc.)
 * - Per-tool: name, description, parameters, and BFCL XML usage example
 *
 * @param tools - Tool definitions to render.
 * @returns A formatted string to append to the system prompt.
 */
export function renderToolsBlock(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';

  const lines: string[] = [
    'The following tools are available for carrying out this task.',
    'You can invoke tools using XML-style tags. Each tool call is wrapped in a tool tag, and each parameter uses a `<param>` tag with `name` and `type` attributes.',
    '',
    'Format:',
    '',
    '<tool_name>',
    '<param name="parameter1_name" type="string" required="true">value1</param>',
    '<param name="parameter2_name" type="integer" required="false">42</param>',
    '</tool_name>',
    '',
    'Important rules:',
    '- Always use the exact tool and parameter names as defined below.',
    '- Include ONLY required parameters. Do NOT add optional parameters unless you need to set a non-default value.',
    '- A tool call MUST be the last content in your response. Do NOT append empty tags or any text after the closing tool tag.',
    '- Only call one tool at a time.',
    '- For boolean parameters, use "true" or "false" (lowercase strings).',
    '- For parameters expecting a number, provide the numeric value directly.',
    '- For parameters that accept objects or arrays, provide valid JSON.',
    '- Each parameter inside a tool call MUST use the `<param name="...">` tag format.',
    '',
    'Example of a CORRECT tool call:',
    '',
    'I\'ll list the files in the current directory.',
    '',
    '<Bash>',
    '<param name="command" type="string" required="true">ls</param>',
    '</Bash>',
    '',
    'INCORRECT — do NOT do this (extra parameters, wrong tag format):',
    '',
    '<Bash>',
    '<command>ls</command>',
    '<param name="description" type="string">List files</param>',
    '</Bash>',
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
 * Render a single tool definition with BFCL-style XML usage example.
 */
function renderOneTool(tool: ToolDefinition): string[] {
  const schema = tool.input_schema as Record<string, unknown>;
  const params = extractParams(schema);
  const lines: string[] = [];

  // Tool header + description + parameters
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

  // BFCL-style XML Usage section
  const required = params.filter(p => p.required);
  const optional = params.filter(p => !p.required);
  lines.push('Usage:');
  lines.push(`<${tool.name}>`);
  for (const p of required) {
    lines.push(`<param name="${p.name}" type="${xmlType(p)}" required="true">${exampleValue(p)}</param>`);
  }
  for (const p of optional) {
    lines.push(`<param name="${p.name}" type="${xmlType(p)}" required="false">${exampleValue(p)}</param>`);
  }
  lines.push(`</${tool.name}>`);
  if (optional.length > 0) {
    const optionalNames = optional.map(p => p.name).join(', ');
    lines.push(`(Optional parameters: ${optionalNames} — omit unless needed)`);
  }
  lines.push('');

  return lines;
}

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

/**
 * Map a JSON Schema type to the XML type string used in BFCL.
 *
 * BFCL recognises: string, integer, float, boolean, array, dict, tuple.
 */
function xmlType(param: ParamInfo): string {
  switch (param.type) {
    case 'string':  return 'string';
    case 'integer': return 'integer';
    case 'number':  return 'float';
    case 'boolean': return 'boolean';
    case 'array':   return 'array';
    case 'object':  return 'dict';
    default:        return 'string';
  }
}

/** Generate a sensible placeholder value for usage examples. */
function exampleValue(param: ParamInfo): string {
  if (param.defaultValue !== undefined) {
    if (typeof param.defaultValue === 'string') return param.defaultValue;
    return JSON.stringify(param.defaultValue);
  }
  if (param.enumValues && param.enumValues.length > 0) {
    return String(param.enumValues[0]);
  }
  switch (param.type) {
    case 'boolean': return 'true';
    case 'integer': return '42';
    case 'number': return '3.14';
    case 'array': return '[]';
    case 'object': return '{}';
    default: return param.description || 'value';
  }
}
