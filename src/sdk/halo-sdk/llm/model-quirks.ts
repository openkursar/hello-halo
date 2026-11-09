/**
 * @module llm/model-quirks
 * Non-standard model adaptations.
 * Fixes common issues with Qwen, DeepSeek, GLM, Kimi and other models that
 * deviate from the Anthropic/OpenAI wire format.
 * @license MIT
 */

import type {
  ContentBlock,
  ProviderResponse,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from '../types/provider.js';

// ---------------------------------------------------------------------------
// Model detection
// ---------------------------------------------------------------------------

/** Known model prefixes that require quirks processing. */
const QUIRKY_PREFIXES = ['qwen', 'deepseek', 'glm', 'kimi', 'moonshot', 'minimax', 'abab'];

/**
 * OpenAI o-series model prefixes.
 * These models use `max_completion_tokens` instead of `max_tokens`,
 * do not accept a `temperature` parameter, and support `reasoning_effort`.
 * Matches: o1, o1-mini, o1-preview, o3, o3-mini, o4-mini, o4, etc.
 */
const O_SERIES_PREFIXES = ['o1', 'o3', 'o4'];

/**
 * Returns `true` if the model is an OpenAI o-series reasoning model
 * (o1*, o3*, o4*). These models have different API parameters from standard
 * chat models: `max_completion_tokens` replaces `max_tokens`, `temperature`
 * is not supported, and `reasoning_effort` controls thinking depth.
 */
export function isOSeriesModel(model: string): boolean {
  const lower = model.toLowerCase();
  // Strip leading provider prefix if present (e.g. "openai/o3-mini" → "o3-mini")
  const name = lower.includes('/') ? lower.split('/').pop()! : lower;
  return O_SERIES_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}-`));
}

/**
 * Model prefixes that use XML-style `<think>...</think>` tags for reasoning.
 * These models interleave thinking content with regular output using XML tags
 * rather than a dedicated `reasoning` or `reasoning_content` field.
 * Covers: Qwen-series (Alibaba), GLM-Think-series (Zhipu AI).
 */
const XML_THINK_PREFIXES = ['qwen', 'glm'];

/** Returns `true` if the model is known to need quirks processing. */
export function isQuirkyModel(model: string): boolean {
  const lower = model.toLowerCase();
  return QUIRKY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Returns `true` if the model uses XML `<think>...</think>` tags for reasoning. */
export function isXmlThinkModel(model: string): boolean {
  const lower = model.toLowerCase();
  return XML_THINK_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Response-level quirks
// ---------------------------------------------------------------------------

/**
 * Apply all applicable model-specific fixes to a complete `ProviderResponse`.
 *
 * Quirks applied:
 * 1. Qwen: extract `<think>...</think>` tags from text into ThinkingBlocks
 * 2. DeepSeek: repair malformed tool_call JSON arguments
 * 3. Generic: auto-generate missing tool_call_id
 * 4. Generic: inject empty TextBlock when content is empty but tool_calls exist
 * 5. Generic: fix stopReason 'end_turn' when pending tool_use blocks exist
 */
export function applyModelQuirks(
  model: string,
  response: ProviderResponse,
): ProviderResponse {
  const lower = model.toLowerCase();
  let content = [...response.content];
  let { stopReason } = response;

  // 1. XML think-tag models (Qwen, GLM-Think, etc.): extract <think>…</think>
  if (isXmlThinkModel(model)) {
    content = extractXmlThinking(content);
  }

  // 2. DeepSeek: repair tool_call arguments
  if (lower.startsWith('deepseek')) {
    content = repairToolCallArguments(content);
  }

  // 3. Generic: auto-generate missing tool_call_id
  content = fillMissingToolIds(content);

  // 4. Generic: empty content + tool_calls → inject empty TextBlock
  content = ensureNonEmptyContent(content);

  // 5. Generic: fix stopReason when tool_use blocks are present
  const hasToolUse = content.some((b) => b.type === 'tool_use');
  if (hasToolUse && stopReason === 'end_turn') {
    stopReason = 'tool_use';
  }

  return {
    ...response,
    content,
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Stream-level quirks — stateful ThinkTagParser
// ---------------------------------------------------------------------------

/**
 * Splits XML thinking from text, retaining only a possible tag prefix (at most
 * seven characters) between chunks. Flush once after a successful finish.
 */
export class ThinkTagParser {
  private inThinkTag = false;
  private tagPrefix = '';
  private skipNewlines = false;

  process(text: string, index: number): StreamEvent[] {
    const events: StreamEvent[] = [];
    const input = this.tagPrefix + text;
    this.tagPrefix = '';
    let offset = 0;

    while (offset < input.length) {
      if (this.skipNewlines) {
        while (input[offset] === '\n' || input[offset] === '\r') offset++;
        if (offset === input.length) break;
        this.skipNewlines = false;
      }
      const tag = this.inThinkTag ? '</think>' : '<think>';
      const tagAt = input.indexOf(tag, offset);
      if (tagAt !== -1) {
        const content = input.slice(offset, tagAt);
        if (content) events.push(this.contentEvent(content, index));
        this.inThinkTag = !this.inThinkTag;
        this.skipNewlines = !this.inThinkTag;
        offset = tagAt + tag.length;
      } else {
        let retained = Math.min(tag.length - 1, input.length - offset);
        while (retained > 0 && !input.endsWith(tag.slice(0, retained))) retained--;
        const content = input.slice(offset, input.length - retained);
        if (content) events.push(this.contentEvent(content, index));
        this.tagPrefix = input.slice(input.length - retained);
        break;
      }
    }
    return events;
  }

  flush(index: number): StreamEvent[] {
    const remainder = this.tagPrefix;
    this.tagPrefix = '';
    return remainder ? [this.contentEvent(remainder, index)] : [];
  }

  private contentEvent(content: string, index: number): StreamEvent {
    return this.inThinkTag
      ? { type: 'reasoning_delta', index, reasoning: content }
      : { type: 'text_delta', index, text: content };
  }

  /** Whether the parser is currently inside a `<think>` block. */
  get isInsideThinkTag(): boolean {
    return this.inThinkTag;
  }
}

/**
 * Apply model-specific fixes to a single `StreamEvent`.
 *
 * Note: For `text_delta` events on Qwen models, use `ThinkTagParser.process()`
 * instead — it handles `<think>` tags that span multiple SSE chunks correctly.
 * This function only handles events other than `text_delta`.
 */
export function applyStreamQuirks(
  _model: string,
  event: StreamEvent,
): StreamEvent {
  // No stateless fixes needed currently — kept for API compatibility.
  return event;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract `<think>...</think>` blocks from TextBlocks and convert them to
 * ThinkingBlocks. The thinking text is removed from the original TextBlock.
 * Used for models that embed reasoning in XML tags (Qwen, GLM-Think, etc.).
 */
function extractXmlThinking(blocks: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;

  for (const block of blocks) {
    if (block.type !== 'text') {
      result.push(block);
      continue;
    }

    const textBlock = block as TextBlock;
    let match: RegExpExecArray | null;
    const thinkingParts: string[] = [];

    // Collect all <think> content
    while ((match = thinkRegex.exec(textBlock.text)) !== null) {
      thinkingParts.push(match[1].trim());
    }

    if (thinkingParts.length > 0) {
      // Emit ThinkingBlock(s) before the cleaned text
      for (const thinking of thinkingParts) {
        if (thinking) {
          result.push({
            type: 'thinking',
            thinking,
          } as ThinkingBlock);
        }
      }

      // Remove <think> tags from the text
      const cleanedText = textBlock.text.replace(thinkRegex, '').trim();
      if (cleanedText) {
        result.push({ type: 'text', text: cleanedText } as TextBlock);
      }
    } else {
      result.push(block);
    }
  }

  return result;
}

/**
 * Attempt to repair malformed tool_call JSON arguments.
 * DeepSeek sometimes emits arguments that are not valid JSON.
 * Strategy: try JSON.parse first, then fall back to regex key-value extraction.
 */
function repairToolCallArguments(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== 'tool_use') {
      return block;
    }

    const toolBlock = block as ToolUseBlock;

    // If input is already a valid object, nothing to repair
    if (
      toolBlock.input &&
      typeof toolBlock.input === 'object' &&
      Object.keys(toolBlock.input).length > 0
    ) {
      return block;
    }

    // If input was serialized as a string somewhere in the pipeline, try to parse
    const inputStr =
      typeof toolBlock.input === 'string'
        ? (toolBlock.input as unknown as string)
        : JSON.stringify(toolBlock.input);

    try {
      const parsed = JSON.parse(inputStr);
      if (typeof parsed === 'object' && parsed !== null) {
        return { ...toolBlock, input: parsed };
      }
    } catch {
      // Fall back to regex extraction of key-value pairs
      const extracted = extractKeyValues(inputStr);
      if (Object.keys(extracted).length > 0) {
        return { ...toolBlock, input: extracted };
      }
    }

    return block;
  });
}

/**
 * Best-effort key-value extraction from malformed JSON-like strings.
 * Handles patterns like: `key: "value"`, `"key": value`, `key = value`
 */
function extractKeyValues(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Match "key": "value" or "key": value patterns
  const kvRegex = /"?(\w+)"?\s*[:=]\s*"([^"]*?)"/g;
  let match: RegExpExecArray | null;

  while ((match = kvRegex.exec(text)) !== null) {
    result[match[1]] = match[2];
  }

  // Also try to extract numeric/boolean values: "key": 123 or "key": true
  const numBoolRegex = /"?(\w+)"?\s*[:=]\s*(true|false|\d+(?:\.\d+)?)\b/g;
  while ((match = numBoolRegex.exec(text)) !== null) {
    if (!(match[1] in result)) {
      const val = match[2];
      if (val === 'true') result[match[1]] = true;
      else if (val === 'false') result[match[1]] = false;
      else result[match[1]] = Number(val);
    }
  }

  return result;
}

/** Auto-generate `toolu_`-prefixed IDs for ToolUseBlocks that lack an id. */
function fillMissingToolIds(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== 'tool_use') return block;
    const toolBlock = block as ToolUseBlock;
    if (!toolBlock.id || toolBlock.id === '') {
      return {
        ...toolBlock,
        id: `toolu_${generateSimpleId()}`,
      };
    }
    return block;
  });
}

/**
 * Ensure the content array is not empty when tool_use blocks are present.
 * Some models return an empty content array alongside tool_calls in the
 * response. We inject an empty TextBlock to keep the message structure valid.
 */
function ensureNonEmptyContent(blocks: ContentBlock[]): ContentBlock[] {
  const hasToolUse = blocks.some((b) => b.type === 'tool_use');
  const hasText = blocks.some((b) => b.type === 'text');

  if (hasToolUse && !hasText) {
    return [{ type: 'text', text: '' } as TextBlock, ...blocks];
  }

  return blocks;
}

/** Generate a simple pseudo-random ID string (no crypto dependency). */
function generateSimpleId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const timestamp = Date.now().toString(36);
  let random = '';
  for (let i = 0; i < 12; i++) {
    random += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${timestamp}${random}`;
}
