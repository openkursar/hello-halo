/**
 * @module llm/cache-breakpoints
 * SDK cache-marker placement for Anthropic requests: reserve one of the API's
 * four breakpoints for message history and up to three for system blocks.
 * Placement is an SDK policy; cache hits and savings depend on the request.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single cache-control marker as accepted by the Anthropic API. */
export interface CacheControl {
  type: 'ephemeral';
  /** Optional 1-hour TTL (requires extended-cache-ttl beta). */
  ttl?: '1h';
}

/** Minimal content block shape for breakpoint placement. */
export interface ContentBlockLike {
  type: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

/** Minimal message shape for breakpoint placement. */
export interface MessageLike {
  role: string;
  // Allow typed ContentBlockLike arrays or any unknown[] (e.g. provider.Message content)
  content: string | ContentBlockLike[];
}

// ---------------------------------------------------------------------------
// buildCacheControl
// ---------------------------------------------------------------------------

/**
 * Create a cache_control object.
 * Pass `extendedTtl: true` to request the 1-hour TTL.
 */
function buildCacheControl(extendedTtl = false): CacheControl {
  return extendedTtl ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

// ---------------------------------------------------------------------------
// addCacheBreakpoints
// ---------------------------------------------------------------------------

/**
 * Mutate a copy of the messages array to add a single cache_control breakpoint
 * on the appropriate content block.
 *
 * Strategy:
 * - Normal request: breakpoint on the last non-thinking block of the last message.
 * - skipCacheWrite excludes the newest message from the cached prefix.
 *
 * Thinking blocks (`type === 'thinking'` or `type === 'redacted_thinking'`) are
 * never marked with cache_control — the API will reject such requests.
 *
 * @param messages  Conversation messages to process.
 * @param options.enableCaching    When false, returns messages unchanged.
 * @param options.skipCacheWrite   When true, marker goes on second-to-last message.
 * @param options.extendedTtl      When true, the cache_control includes ttl: '1h'.
 * @returns A new array of message objects (does not mutate originals).
 */
export function addCacheBreakpoints(
  messages: MessageLike[],
  options: {
    enableCaching?: boolean;
    skipCacheWrite?: boolean;
    extendedTtl?: boolean;
  } = {},
): MessageLike[] {
  const { enableCaching = true, skipCacheWrite = false, extendedTtl = false } = options;

  if (!enableCaching || messages.length === 0) {
    return messages;
  }

  // Determine which message index gets the breakpoint
  const markerIndex = skipCacheWrite
    ? Math.max(0, messages.length - 2)
    : messages.length - 1;

  const cacheControl = buildCacheControl(extendedTtl);

  return messages.map((msg, index) => {
    if (index !== markerIndex) {
      // Not the target message — return a shallow clone to avoid mutations
      return { ...msg };
    }
    return applyBreakpointToMessage(msg, cacheControl);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return a copy of `msg` with a cache_control applied to the last eligible
 * content block (skipping thinking/redacted_thinking blocks from the tail).
 */
function applyBreakpointToMessage(msg: MessageLike, cacheControl: CacheControl): MessageLike {
  if (typeof msg.content === 'string') {
    // String content — wrap into an array with cache_control on the text block
    return {
      ...msg,
      content: [{ type: 'text', text: msg.content, cache_control: cacheControl }],
    };
  }

  const blocks = msg.content as ContentBlockLike[];
  if (blocks.length === 0) {
    return { ...msg };
  }

  // Find the last block that can carry cache_control (not a thinking block)
  let targetIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const blockType = blocks[i]?.type;
    if (blockType !== 'thinking' && blockType !== 'redacted_thinking') {
      targetIdx = i;
      break;
    }
  }

  if (targetIdx === -1) {
    // All blocks are thinking blocks — cannot place a breakpoint; return as-is
    return { ...msg, content: [...blocks] };
  }

  // Build a new content array with the cache_control on the target block
  const newContent = blocks.map((block, i) => {
    if (i !== targetIdx) return block;
    return { ...block, cache_control: cacheControl };
  });

  return { ...msg, content: newContent };
}

// ---------------------------------------------------------------------------
// System prompt cache breakpoints
// ---------------------------------------------------------------------------

/**
 * Apply cache_control to system prompt blocks.
 *
 * For a simple system prompt (single string) this wraps it into a single block
 * with cache_control. For a pre-structured array of blocks it applies
 * cache_control to each block that is eligible for caching. Blocks that
 * already carry `cache_control` are preserved as-is; blocks without it get
 * a marker added. The last block in the array (typically the dynamic portion)
 * is left unmarked since it changes every turn and caching it would waste
 * a breakpoint slot.
 *
 * Reserve one of the API's four cache breakpoints for message history.
 * Cache hits depend on provider support and an unchanged request prefix.
 *
 * @param systemPrompt  String or array of `{ type: 'text', text: string }` blocks.
 * @param options.extendedTtl  When true, uses 1-hour TTL.
 * @returns  An array of `{ type: 'text', text: string, cache_control?: CacheControl }` blocks.
 */
export function addSystemPromptCacheBreakpoint(
  systemPrompt: string | Array<{ type: 'text'; text: string; cache_control?: CacheControl }>,
  options: { extendedTtl?: boolean } = {},
): Array<{ type: 'text'; text: string; cache_control?: CacheControl }> {
  const cacheControl = buildCacheControl(options.extendedTtl);

  if (typeof systemPrompt === 'string') {
    return [{ type: 'text', text: systemPrompt, cache_control: cacheControl }];
  }

  if (systemPrompt.length === 0) return [];

  // Single block: mark it directly.
  if (systemPrompt.length === 1) {
    return [{ ...systemPrompt[0], cache_control: cacheControl }];
  }

  // Multiple blocks: mark at most the 3 stable blocks closest to the tail
  // (excluding the last block, which carries dynamic per-turn content —
  // caching it would invalidate on the next turn). The API allows 4
  // breakpoints per request; capping system breakpoints at 3 reserves the
  // fourth for the message-level marker.
  const lastIdx = systemPrompt.length - 1;
  const firstMarkable = Math.max(0, lastIdx - 3);
  return systemPrompt.map((block, i) => {
    if (i >= firstMarkable && i < lastIdx) {
      // Stable block — add cache_control (preserve existing if already set)
      return block.cache_control
        ? { ...block }
        : { ...block, cache_control: cacheControl };
    }
    return { ...block };
  });
}
