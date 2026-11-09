/**
 * @module llm/tool-calling/xml-parser
 * Parses XML-format tool calls from model text output.
 *
 * Supports two XML formats with automatic detection:
 * - BFCL style: `<param name="key" type="t">value</param>`
 * - Legacy style: `<key>value</key>` (parameter name = tag name)
 *
 * Strategy: "relaxed scan" — regex-based matching against known tool names.
 * Handles multi-line parameters, JSON values, boolean/number coercion, and
 * multiple tool calls in a single response.
 * @license MIT
 */

import type { ParseResult, ParsedToolCall } from './types.js';

// ---------------------------------------------------------------------------
// parseXmlToolCalls
// ---------------------------------------------------------------------------

/**
 * Parse all XML tool calls from a model text response.
 *
 * Only tool names listed in `knownToolNames` are recognized. Unknown tags in
 * the text are left untouched.
 *
 * @param text           - Full text output from the model.
 * @param knownToolNames - Tool names the model may legally call.
 * @returns ParseResult with textContent (prose before the first call) and
 *          toolCalls in order of appearance.
 */
export function parseXmlToolCalls(
  text: string,
  knownToolNames: string[],
): ParseResult {
  if (knownToolNames.length === 0 || !text) {
    return { textContent: text, toolCalls: [] };
  }

  // Build a regex that matches any of the known tool tags.
  // Uses [\s\S]*? (non-greedy, dotAll equivalent) to handle multi-line bodies.
  const escapedNames = knownToolNames.map(escapeRegex).join('|');
  const toolRegex = new RegExp(
    `<(${escapedNames})>([\\s\\S]*?)<\\/\\1>`,
    'g',
  );

  const toolCalls: ParsedToolCall[] = [];
  const matchRanges: Array<[number, number]> = []; // [start, end] of each match

  let match: RegExpExecArray | null;
  while ((match = toolRegex.exec(text)) !== null) {
    const toolName = match[1];
    const innerContent = match[2];
    const rawXml = match[0];
    const matchStart = match.index;
    const matchEnd = match.index + rawXml.length;

    const parameters = parseParameters(innerContent);

    toolCalls.push({ name: toolName, parameters, rawXml });
    matchRanges.push([matchStart, matchEnd]);
  }

  // Build textContent: everything before the first tool call.
  // (Text between tool calls is discarded — not part of the model's prose.)
  let textContent: string;
  if (matchRanges.length === 0) {
    textContent = text;
  } else {
    textContent = text.slice(0, matchRanges[0][0]).trimEnd();
  }

  return { textContent, toolCalls };
}

// ---------------------------------------------------------------------------
// parseParameters — dual-format support
// ---------------------------------------------------------------------------

/**
 * Parse parameter key-value pairs from the inner XML of a tool call block.
 *
 * Tries BFCL format first:
 *   `<param name="key" type="t">value</param>`
 *
 * Falls back to legacy format when no BFCL matches found:
 *   `<key>value</key>`
 *
 * Values are coerced: JSON → object/array/number/boolean, then "true"/"false"
 * → boolean, numeric string → number, otherwise raw string.
 */
function parseParameters(innerContent: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // ------------------------------------------------------------------
  // Format A: BFCL — <param name="key" type="t" required="true|false">value</param>
  // ------------------------------------------------------------------
  const bfclRegex = /<param\s+([^>]+)>([\s\S]*?)<\/param>/g;

  let match: RegExpExecArray | null;
  while ((match = bfclRegex.exec(innerContent)) !== null) {
    const attrsStr = match[1];
    const rawValue = match[2];

    // Extract name= attribute (required)
    const nameMatch = attrsStr.match(/name="([^"]*)"/);
    if (!nameMatch) continue;

    const paramName = nameMatch[1];
    if (!paramName) continue;

    result[paramName] = coerceParamValue(rawValue);
  }

  // If BFCL format matched at least one parameter, return.
  // Don't mix formats — prevents double-parsing.
  if (Object.keys(result).length > 0) {
    return result;
  }

  // ------------------------------------------------------------------
  // Format B: Legacy — <key>value</key>
  // ------------------------------------------------------------------
  const legacyRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  while ((match = legacyRegex.exec(innerContent)) !== null) {
    const paramName = match[1];
    const rawValue = match[2];

    result[paramName] = coerceParamValue(rawValue);
  }

  // Also handle self-closing tags: <param/>
  const selfClosingRegex = /<(\w+)\s*\/>/g;
  while ((match = selfClosingRegex.exec(innerContent)) !== null) {
    const paramName = match[1];
    if (!(paramName in result)) {
      result[paramName] = '';
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// coerceParamValue
// ---------------------------------------------------------------------------

/**
 * Coerce a raw string parameter value to its most appropriate JS type.
 *
 * Priority:
 *   1. JSON.parse → object / array / number / boolean literal
 *   2. "true" / "false" → boolean
 *   3. Pure numeric string → number
 *   4. Raw string (trimmed)
 */
function coerceParamValue(raw: string): unknown {
  const trimmed = raw.trim();

  // 1. Try JSON parse (handles objects, arrays, quoted strings, numbers, booleans, null)
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed;
    } catch {
      // Fall through
    }
  }

  // 2. Boolean literals
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // 3. Numeric string
  if (trimmed !== '' && !isNaN(Number(trimmed))) {
    return Number(trimmed);
  }

  // 4. Raw string — trim leading/trailing whitespace, preserve internal formatting
  return trimmed;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
