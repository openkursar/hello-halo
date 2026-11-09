/**
 * @module llm/tool-calling/json-parser
 * Parses JSON code-fence tool calls from model text output.
 *
 * Strategy: extract the last ```json ... ``` block from the response,
 * parse the JSON array, and validate each entry against known tool names.
 *
 * Compared to XML parsing:
 *   - No regex-based tag matching edge cases.
 *   - Native type preservation (no coercion needed).
 *   - Handles multi-line string values naturally (JSON escapes).
 *
 * @license MIT
 */

import type { ParseResult, ParsedToolCall } from './types.js';

// ---------------------------------------------------------------------------
// parseJsonToolCalls
// ---------------------------------------------------------------------------

/**
 * Parse JSON tool calls from a model text response.
 *
 * Looks for the last ```json ... ``` code fence in the text, parses its
 * content as a JSON array, and extracts tool call objects.
 *
 * Expected format:
 * ```json
 * [{"name": "Bash", "params": {"command": "ls"}}]
 * ```
 *
 * @param text           - Full text output from the model.
 * @param knownToolNames - Tool names the model may legally call (used for
 *                         validation; unknown names are skipped with a warning).
 * @returns ParseResult with textContent (prose before the FIRST code fence)
 *          and toolCalls in order of appearance.
 */
export function parseJsonToolCalls(
  text: string,
  knownToolNames: string[],
): ParseResult {
  if (knownToolNames.length === 0 || !text) {
    return { textContent: text, toolCalls: [] };
  }

  // Find all ```json ... ``` blocks
  const fenceRegex = /```json\s*([\s\S]*?)\s*```/g;
  const matches: Array<{ content: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    matches.push({
      content: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  if (matches.length === 0) {
    return { textContent: text, toolCalls: [] };
  }

  // Extract text before the first code fence as prose
  const textContent = text.slice(0, matches[0].start).trimEnd();

  // Parse the LAST code fence as tool calls (models sometimes emit
  // intermediate JSON blocks during reasoning; the final one is authoritative)
  const lastMatch = matches[matches.length - 1];

  const toolCalls: ParsedToolCall[] = [];
  let sawToolCallShape = false;
  try {
    const parsed = JSON.parse(lastMatch.content);

    if (!Array.isArray(parsed)) {
      // Not an array — treat as plain text response (preserve full text)
      return { textContent: text, toolCalls: [] };
    }
    sawToolCallShape = true;

    const knownSet = new Set(knownToolNames);

    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;

      const name = item.name;
      const params = item.params;

      if (typeof name !== 'string' || !name) continue;
      if (!knownSet.has(name)) continue;

      toolCalls.push({
        name,
        parameters: params && typeof params === 'object' ? params : {},
        rawXml: JSON.stringify(item), // Reuse rawXml field for JSON raw (debugging)
      });
    }
  } catch (err: unknown) {
    // The fence is kept in the returned text so the model can see what it
    // wrote, and the reason travels with it so the caller can say what broke.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      textContent: text,
      toolCalls: [],
      unreadable: `a \`\`\`json tool-call block that was not valid JSON (${reason})`,
    };
  }

  // A well-formed array that yielded nothing means every entry was unusable:
  // no name, an unknown name, or the wrong shape.
  if (sawToolCallShape && toolCalls.length === 0) {
    return {
      textContent: text,
      toolCalls: [],
      unreadable:
        'a ```json tool-call block whose entries named no known tool; each entry ' +
        'needs a "name" matching an available tool and a "params" object',
    };
  }

  return { textContent, toolCalls };
}
