/**
 * @module utils/truncate
 * Content truncation utilities for tool results and general text.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum characters for a single tool result. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Token ceiling; its byte size depends on the content and tokenizer. */
export const MAX_TOOL_RESULT_TOKENS = 100_000;

/** Maximum total characters across all tool results in a single message. */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/** A V8 substring can otherwise retain its much larger source allocation. */
export function copyString(content: string): string {
  return Buffer.from(content, 'utf16le').toString('utf16le');
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate content to a maximum character count.
 * When truncated, inserts a marker in the middle indicating how much was removed.
 *
 * @param content - The text content to truncate
 * @param maxChars - Maximum returned UTF-16 code units, including the omission notice
 * @returns The (potentially truncated) content
 */
export function truncateContent(
  content: string,
  maxChars: number,
  recoveryHint = 'Request a smaller range or a more specific query to obtain the omitted content.',
): string {
  if (maxChars === Infinity) return content;
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError('Text output budget must be a nonnegative integer');
  }
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars === 0) return '';

  let notice = (omitted: number) => `\n\n[Content truncated: ${omitted} chars omitted from the middle. ${recoveryHint}]\n\n`;
  if (notice(content.length).length >= maxChars) {
    notice = omitted => `\n[Content truncated: ${omitted} chars omitted]\n`;
  }
  const reserved = notice(content.length).length;
  if (reserved > maxChars) return maxChars >= 11 ? '[truncated]' : '…';

  const retained = maxChars - reserved;
  let headEnd = Math.floor(retained / 2);
  let tailStart = content.length - (retained - headEnd);
  // A UTF-16 pair must remain together even when the requested budget is odd.
  if (splitsSurrogate(content, headEnd)) headEnd--;
  if (splitsSurrogate(content, tailStart)) tailStart++;
  const omitted = tailStart - headEnd;
  return copyString(content.slice(0, headEnd) + notice(omitted) + content.slice(tailStart));
}

function splitsSurrogate(content: string, offset: number): boolean {
  const before = content.charCodeAt(offset - 1);
  const after = content.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Truncate a tool result to fit within the tool result budget.
 * Uses the same head/tail strategy as truncateContent.
 *
 * @param content - Tool result content to truncate
 * @param budget - Maximum characters (defaults to DEFAULT_MAX_RESULT_SIZE_CHARS)
 * @returns The (potentially truncated) content
 */
export function truncateToolResult(
  content: string,
  budget: number = DEFAULT_MAX_RESULT_SIZE_CHARS,
): string {
  return truncateContent(content, budget);
}
