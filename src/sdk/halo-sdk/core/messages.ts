/**
 * @module core/messages
 * Message construction and serialization utilities for the query loop.
 * @license MIT
 */

import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
} from '../types/provider.js';
import type { ToolResultImage } from '../types/tool.js';
import { mergeToolContextRecords, type ToolContextRecord } from './tool-context/index.js';
import { estimateContentBlockTokens, estimateTokens } from '../utils/tokens.js';
import { getLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Re-exports — system-reminder utilities
// ---------------------------------------------------------------------------

export {
  wrapInSystemReminder,
  buildSystemReminderMessage,
  isSystemReminderContent,
  extractSystemReminderContent,
} from '../utils/system-reminder.js';

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/**
 * Build a user message from text or structured content blocks.
 */
export function buildUserMessage(
  content: string | ContentBlock[],
): Message {
  return { role: 'user', content };
}

/**
 * Build a tool-result user message from an array of tool results.
 * Each result maps to a ToolResultBlock content block. Results carrying
 * images become structured content (text block + image blocks); the rest
 * stay plain strings.
 */
export function buildToolResultMessage(
  results: Array<{
    toolUseId: string;
    content: string;
    isError: boolean;
    images?: ToolResultImage[];
    toolContext?: ToolContextRecord;
  }>,
): Message {
  const blocks: ToolResultBlock[] = results.map((r) => ({
    type: 'tool_result' as const,
    tool_use_id: r.toolUseId,
    content: toToolResultContent(r.content, r.images),
    is_error: r.isError || undefined,
  }));

  return {
    role: 'user',
    content: blocks,
    ...(results.some(result => result.toolContext) ? {
      toolContext: results.reduce<ToolContextRecord | undefined>((record, result) =>
        mergeToolContextRecords(record, result.toolContext), undefined),
    } : {}),
  };
}

/**
 * Text plus optional base64 images as structured tool_result content. An
 * empty text body emits no text block — the API rejects empty text blocks,
 * and a tool_result of image blocks alone is valid.
 */
function toToolResultContent(
  content: string,
  images?: ToolResultImage[],
): string | ContentBlock[] {
  if (!images || images.length === 0) {
    return content;
  }
  const blocks: ContentBlock[] = [];
  if (content.length > 0) {
    blocks.push({ type: 'text', text: content });
  }
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data },
    } as ImageBlock);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Defensive pairing — recovery layer for tool_use/tool_result mismatches
// ---------------------------------------------------------------------------

/** A missing result cannot establish whether its tool call succeeded. */
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[No recorded output for this tool call; its outcome is unknown.]';

/** Placeholder pushed when stripping an empty assistant message would leave
 *  a hole the API rejects. */
export const TOOL_USE_INTERRUPTED_PLACEHOLDER = '[No usable assistant content remains after history repair.]';

/** Placeholder pushed when a leading user message with only orphan tool_results
 *  would otherwise become empty AND is the first message in the array. */
export const ORPHAN_TOOL_RESULT_REMOVED_PLACEHOLDER =
  '[A saved tool response had no matching call in this history.]';

/** Filler used when a tool_result-only user message becomes empty mid-array;
 *  needed to maintain user/assistant role alternation. */
export const NO_USER_CONTENT_PLACEHOLDER = '(no content)';

/** What {@link repairToolResultPairing} had to change. */
export interface ToolPairingChanges {
  duplicateCalls: number;
  /** Results dropped for want of an open call; includes {@link lateResults}. */
  discardedResults: number;
  /** Dropped results whose call was issued earlier: recorded output that could not be used. */
  lateResults: number;
  missingResults: number;
  emptyResponses: number;
}

/**
 * Reconcile the result slot after each assistant message without changing the
 * input history. Missing outputs describe interrupted work, never a successful
 * tool execution. The first occurrence of a call ID owns its result slot.
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  return repairToolResultPairing(messages).messages;
}

/** {@link ensureToolResultPairing}, also reporting what was changed. */
export function repairToolResultPairing(messages: Message[]): { messages: Message[]; changes: ToolPairingChanges } {
  const repaired: Message[] = [];
  const issued = new Set<string>();
  const waiting = new Map<string, ToolUseBlock>();
  const changes: ToolPairingChanges = { duplicateCalls: 0, discardedResults: 0, lateResults: 0, missingResults: 0, emptyResponses: 0 };

  const takeMissingResults = (): ToolResultBlock[] => {
    const replacements: ToolResultBlock[] = [];
    for (const id of waiting.keys()) {
      replacements.push({
        type: 'tool_result',
        tool_use_id: id,
        content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
        is_error: true,
      });
    }
    changes.missingResults += replacements.length;
    waiting.clear();
    return replacements;
  };

  const closeResultSlot = (): void => {
    if (waiting.size > 0) {
      repaired.push({ role: 'user', content: takeMissingResults(), isMeta: true });
    }
  };

  for (const message of messages) {
    if (message.role === 'assistant') {
      closeResultSlot();
      if (typeof message.content === 'string') {
        repaired.push(message);
        continue;
      }
      const kept = message.content.filter((block) => {
        if (block.type !== 'tool_use') return true;
        if (issued.has(block.id)) {
          changes.duplicateCalls++;
          return false;
        }
        issued.add(block.id);
        waiting.set(block.id, block);
        return true;
      });
      if (kept.length === 0) {
        changes.emptyResponses++;
        repaired.push({ ...message, content: [{ type: 'text', text: TOOL_USE_INTERRUPTED_PLACEHOLDER }] });
      } else {
        repaired.push(kept.length === message.content.length ? message : { ...message, content: kept });
      }
      continue;
    }

    const previousWasAssistant = repaired[repaired.length - 1]?.role === 'assistant';
    const supplied: ContentBlock[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
    let removed = 0;
    const accepted = supplied.filter((block) => {
      if (block.type !== 'tool_result') return true;
      if (waiting.delete(block.tool_use_id)) return true;
      removed++;
      if (issued.has(block.tool_use_id)) changes.lateResults++;
      return false;
    });
    changes.discardedResults += removed;
    const missing = takeMissingResults();
    if (removed === 0 && missing.length === 0) {
      repaired.push(message);
    } else if (accepted.length > 0 || missing.length > 0) {
      repaired.push({ ...message, content: [...missing, ...accepted] });
    } else if (previousWasAssistant) {
      repaired.push({ role: 'user', content: NO_USER_CONTENT_PLACEHOLDER, isMeta: true });
    } else if (repaired.length === 0) {
      repaired.push({ ...message, content: [{ type: 'text', text: ORPHAN_TOOL_RESULT_REMOVED_PLACEHOLDER }] });
    }
  }
  closeResultSlot();

  if (Object.values(changes).some((count) => count > 0)) {
    getLogger('History').warn('tool history repaired before reuse', { ...changes });
  }
  return { messages: repaired, changes };
}

/** Stands in for a reply that consisted only of reasoning once that is removed. */
export const REASONING_OMITTED_PLACEHOLDER = '[Reasoning omitted]';

/**
 * Remove reasoning blocks (`thinking`, `redacted_thinking` and detached
 * signatures) from assistant messages, in place, skipping those `keep` names.
 * Returns how many blocks were removed.
 */
export function stripReasoningBlocks(messages: Message[], keep: (message: Message) => boolean = () => false): number {
  let removed = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || typeof message.content === 'string' || keep(message)) continue;
    const content = message.content.filter((block) => {
      const type = (block as { type: string }).type;
      return type !== 'thinking' && type !== 'redacted_thinking' && type !== 'signature';
    });
    if (content.length === message.content.length) continue;
    removed += message.content.length - content.length;
    messages[index] = {
      ...message,
      content: content.length > 0 ? content : [{ type: 'text', text: REASONING_OMITTED_PLACEHOLDER }],
    };
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

/**
 * Extract all tool_use blocks from an assistant message.
 * Returns an empty array if the message has no tool_use blocks.
 */
export function extractToolUseBlocks(message: Message): ToolUseBlock[] {
  if (typeof message.content === 'string') {
    return [];
  }
  return message.content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use',
  );
}

// ---------------------------------------------------------------------------
// Token estimation for messages
// ---------------------------------------------------------------------------

/**
 * Rough token estimate for a single message.
 * Uses the 4/3 chars ratio heuristic.
 */
export function messageTokenEstimate(message: Message): number {
  if (typeof message.content === 'string') {
    return estimateTokens(message.content) + 4; // +4 for role/structure overhead
  }

  let total = 4; // role/structure overhead
  for (const block of message.content) {
    total += contentBlockTokenEstimate(block);
  }
  return total;
}

/**
 * Total token estimate for an array of messages.
 */
export function messagesToTokenCount(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += messageTokenEstimate(msg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Estimate tokens for a single content block. */
function contentBlockTokenEstimate(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens(block.text);
    case 'thinking':
      return estimateTokens(block.thinking);
    case 'tool_use':
      return (
        estimateTokens(block.name) +
        estimateTokens(JSON.stringify(block.input))
      );
    case 'tool_result': {
      if (typeof block.content === 'string') {
        return estimateTokens(block.content);
      }
      let total = 0;
      for (const sub of block.content) {
        total += contentBlockTokenEstimate(sub);
      }
      return total;
    }
    case 'image':
      return estimateContentBlockTokens(block);
    case 'document':
      return Math.ceil(block.source.data.length * 0.75 * 0.01);
    case 'signature':
      return estimateTokens(block.signature);
    default:
      return 0;
  }
}
