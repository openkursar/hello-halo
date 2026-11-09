/**
 * @module utils/tokens
 * Token estimation utilities using a character-ratio heuristic.
 * English/code averages ~3-4 chars per token (~0.3 tokens/char); CJK text
 * runs denser at roughly 0.6 tokens per character.
 * @license MIT
 */

import type { Message, ContentBlock } from '../types/provider.js';

// ---------------------------------------------------------------------------
// Core estimation
// ---------------------------------------------------------------------------

const NON_CJK_TOKENS_PER_CHAR = 0.3;
const CJK_TOKENS_PER_CHAR = 0.6;

/** Whether a char code falls in the common CJK / fullwidth ranges. */
function isCjkCharCode(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) || // CJK punctuation, kana, unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef)    // fullwidth forms
  );
}

/**
 * Estimate the number of tokens in a text string.
 * Non-CJK text ≈ 0.3 tokens/char (~3.3 chars per token); CJK ≈ 0.6.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCharCode(text.charCodeAt(i))) cjk++;
  }
  return Math.ceil(
    (text.length - cjk) * NON_CJK_TOKENS_PER_CHAR + cjk * CJK_TOKENS_PER_CHAR,
  );
}

// ---------------------------------------------------------------------------
// Content block estimation
// ---------------------------------------------------------------------------

/** Estimate tokens for a single content block. */
export function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens(block.text);
    case 'thinking':
      return estimateTokens(block.thinking);
    case 'tool_use':
      // Tool name + JSON-serialized input
      return (
        estimateTokens(block.name) +
        estimateTokens(JSON.stringify(block.input))
      );
    case 'tool_result': {
      if (typeof block.content === 'string') {
        return estimateTokens(block.content);
      }
      // Array of content blocks
      let total = 0;
      for (const sub of block.content) {
        total += estimateContentBlockTokens(sub);
      }
      return total;
    }
    case 'image':
      // Encoded byte size is not visual complexity. API usage calibrates this
      // fallback; transport limits are enforced separately before dispatch.
      return 1600;
    case 'document':
      return Math.ceil(block.source.data.length * 0.75 * 0.01);
    case 'signature':
      return estimateTokens(block.signature);
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Message-level estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the number of tokens in a single message.
 * Accounts for both string content and structured content blocks.
 */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else {
      for (const block of msg.content) {
        total += estimateContentBlockTokens(block);
      }
    }
    // Add a small overhead per message for role/structure tokens
    total += 4;
  }
  return total;
}

// ---------------------------------------------------------------------------
// API-anchored token tracking
// ---------------------------------------------------------------------------

/**
 * Tracks API-reported token counts to calibrate local estimates.
 *
 * The character-ratio heuristic drifts over long conversations because it
 * cannot account for tokenizer specifics, images, caching headers, etc.
 * When the API reports actual `input_tokens` in its response, we record it
 * alongside the local estimate at that moment. Subsequent estimates are scaled
 * by the ratio of API-reported to locally-estimated tokens.
 *
 * Anchors to real API data when available, falls back to the heuristic otherwise.
 */
export class ApiTokenAnchor {
  /** Last API-reported input token count. */
  private _apiTokens = 0;
  /** Local estimate at the time the API count was recorded. */
  private _localEstimateAtAnchor = 0;

  /** Record an API-reported input token count alongside the current local estimate. */
  anchor(apiInputTokens: number, localEstimate: number): void {
    if (apiInputTokens > 0 && localEstimate > 0) {
      this._apiTokens = apiInputTokens;
      this._localEstimateAtAnchor = localEstimate;
    }
  }

  /**
   * Return the best available token count for the given messages.
   * If we have an anchor, scale the current local estimate by the
   * last-known ratio; otherwise return the raw local estimate.
   */
  estimateWithAnchor(messages: Message[]): number {
    const localEst = estimateMessageTokens(messages);
    if (this._apiTokens > 0 && this._localEstimateAtAnchor > 0) {
      const ratio = this._apiTokens / this._localEstimateAtAnchor;
      return Math.ceil(localEst * ratio);
    }
    return localEst;
  }

  /** Return the last API-reported token count (0 if none recorded). */
  get lastApiTokens(): number {
    return this._apiTokens;
  }

  /** Whether an anchor has been established. */
  get hasAnchor(): boolean {
    return this._apiTokens > 0;
  }

  /** Reset the anchor (e.g. after compaction). */
  reset(): void {
    this._apiTokens = 0;
    this._localEstimateAtAnchor = 0;
  }
}

// ---------------------------------------------------------------------------
// Budget check
// ---------------------------------------------------------------------------

/**
 * Check whether a token count is within a budget.
 * @param tokenCount - Current token count
 * @param maxTokens - Maximum allowed tokens
 * @param threshold - Fraction of maxTokens considered "within budget" (default 0.9)
 * @returns true if tokenCount <= maxTokens * threshold
 */
export function isWithinBudget(
  tokenCount: number,
  maxTokens: number,
  threshold = 0.9,
): boolean {
  return tokenCount <= maxTokens * threshold;
}
