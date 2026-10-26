/**
 * Token Counter
 *
 * Model-aware token counting using official tokenizers.
 *
 * - Claude:    @anthropic-ai/tokenizer singleton (exact, ~99%)
 * - GPT-4o+:  gpt-tokenizer o200k_base (exact, ~95%)
 * - GPT-4/3.5: gpt-tokenizer cl100k_base (exact, ~95%)
 * - Others (Qwen, DeepSeek, GLM, etc.): cl100k_base fallback (~80-85%)
 *
 * Falls back to character-based estimation if tokenizer fails.
 */

import type * as AnthropicTokenizer from '@anthropic-ai/tokenizer'
import type * as O200kEncoding from 'gpt-tokenizer'
import type * as Cl100kEncoding from 'gpt-tokenizer/encoding/cl100k_base'

// ============================================================================
// Tokenizers, loaded on first use
// ============================================================================

// Each tokenizer is required on its first count rather than imported: their
// tables are megabytes of code that the main process would otherwise load
// before the window opens.

/**
 * Lazy singleton for the Claude WASM tokenizer.
 * Creating a Tiktoken instance is expensive (~20ms). By reusing one instance
 * across all calls, subsequent token counts are <1ms instead of ~23ms each.
 */
type ClaudeTokenizer = ReturnType<typeof AnthropicTokenizer.getTokenizer>
let _claudeTokenizer: ClaudeTokenizer | null = null
let _encodeO200k: typeof O200kEncoding.encode | null = null
let _encodeCl100k: typeof Cl100kEncoding.encode | null = null

function getClaudeTokenizer(): ClaudeTokenizer {
  if (!_claudeTokenizer) {
    _claudeTokenizer = (require('@anthropic-ai/tokenizer') as typeof AnthropicTokenizer).getTokenizer()
  }
  return _claudeTokenizer
}

function encodeO200k(text: string): number[] {
  _encodeO200k ??= (require('gpt-tokenizer') as typeof O200kEncoding).encode
  return _encodeO200k(text)
}

function encodeCl100k(text: string): number[] {
  _encodeCl100k ??= (require('gpt-tokenizer/encoding/cl100k_base') as typeof Cl100kEncoding).encode
  return _encodeCl100k(text)
}

// ============================================================================
// Model → Tokenizer Resolution
// ============================================================================

type TokenizerType = 'claude' | 'o200k' | 'cl100k'

/**
 * Map model name to the best available tokenizer.
 *
 * - claude-*                          → Claude tokenizer (exact)
 * - gpt-3.5, gpt-4, gpt-4-turbo     → cl100k_base (legacy OpenAI)
 * - gpt-4o, gpt-4.1, gpt-5+, o1/o3/o4, codex, chatgpt → o200k_base (modern OpenAI)
 * - everything else                   → cl100k_base (best general-purpose BPE approximation)
 */
function resolveTokenizer(model: string): TokenizerType {
  const m = model.toLowerCase()

  // Claude — official Anthropic tokenizer
  if (m.includes('claude')) return 'claude'

  // Legacy OpenAI: gpt-3.x, gpt-4, gpt-4-turbo (NOT gpt-4o, NOT gpt-4.1)
  if (/gpt-(3|4(?!o|\.1))/.test(m)) return 'cl100k'

  // Modern OpenAI: gpt-4o, gpt-4.1, gpt-5+, o-series, codex, chatgpt
  if (/gpt-|^o\d|codex|chatgpt/.test(m)) return 'o200k'

  // All other models (Qwen, DeepSeek, GLM, etc.)
  return 'cl100k'
}

// ============================================================================
// Tokenizer Dispatch
// ============================================================================

function tokenize(text: string, type: TokenizerType): number {
  switch (type) {
    case 'claude':
      return getClaudeTokenizer().encode(text.normalize('NFKC'), 'all').length
    case 'o200k':
      return encodeO200k(text).length
    case 'cl100k':
      return encodeCl100k(text).length
  }
}

// ============================================================================
// Character-Based Fallback
// ============================================================================

/**
 * CJK-aware character estimation.
 * Used only when tokenizer throws (should never happen in practice),
 * and as a lightweight fallback for Kiro adapter (no real usage data).
 *
 * Accuracy targets (vs Claude tokenizer):
 * - Pure Chinese:  ~90-95%
 * - Pure English:  ~85-90%
 * - Mixed content: ~85-90%
 *
 * Ratios derived from Claude BPE tokenizer behavior:
 * - CJK common ideographs: ~1.1 tokens/char (most are single tokens)
 * - CJK rare / Extension:  ~1.5 tokens/char (often byte-fallback)
 * - CJK punctuation:       ~1.0 tokens/char
 * - ASCII letters:         ~0.25 tokens/char (≈4 chars/token)
 * - ASCII digits:          ~0.4 tokens/char  (≈2-3 digits/token)
 * - Space:                 ~0.15 tokens/char (usually merged with next word)
 * - Newline:               ~1.0 tokens/char
 * - Emoji / surrogate:     ~2.0 tokens/char (multi-byte encoding)
 */
export function estimateTokensByChars(text: string): number {
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0

    if (code === 0x0A) {
      // Newline — typically 1 token
      count += 1.0
    } else if (code === 0x20) {
      // Space — often merged with next token
      count += 0.15
    } else if (code >= 0x30 && code <= 0x39) {
      // ASCII digits 0-9
      count += 0.4
    } else if (code < 0x80) {
      // Other ASCII (letters, punctuation)
      count += 0.25
    } else if (
      (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified Ideographs (common)
      (code >= 0xF900 && code <= 0xFAFF)      // CJK Compatibility Ideographs
    ) {
      count += 1.1
    } else if (
      (code >= 0x3400 && code <= 0x4DBF) ||  // CJK Extension A (rare)
      (code >= 0x20000 && code <= 0x2FA1F)    // CJK Extensions B-F (very rare)
    ) {
      count += 1.5
    } else if (
      (code >= 0x3000 && code <= 0x303F) ||  // CJK Symbols & Punctuation (。，、；：)
      (code >= 0xFF00 && code <= 0xFFEF)      // Fullwidth Forms (！？）
    ) {
      count += 1.0
    } else if (code >= 0xAC00 && code <= 0xD7AF) {
      // Korean Hangul Syllables
      count += 1.0
    } else if (code >= 0x3040 && code <= 0x30FF) {
      // Japanese Hiragana + Katakana
      count += 0.7
    } else if (code >= 0x10000) {
      // Emoji, symbols (surrogate pairs) — multi-byte, expensive
      count += 2.0
    } else {
      // Latin Extended, Cyrillic, Arabic, etc.
      count += 0.5
    }
  }
  return Math.ceil(count)
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Count tokens in text using the appropriate tokenizer for the given model.
 *
 * @param text  - Text to count tokens for (typically JSON.stringify'd messages)
 * @param model - Model name (e.g. 'claude-sonnet-4-20250514', 'gpt-4o', 'qwen-plus')
 * @returns Token count
 */
export function countTokens(text: string, model?: string): number {
  if (!text) return 0

  try {
    const type = resolveTokenizer(model ?? '')
    return tokenize(text, type)
  } catch (err) {
    // Tokenizer failure should never block the request
    console.warn('[TokenCounter] Tokenizer failed, using char estimation:', (err as Error).message)
    return estimateTokensByChars(text)
  }
}
