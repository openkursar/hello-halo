/**
 * @module prompt/constants
 * Prompt-related constants for the Agent SDK.
 * @license MIT
 */

// Canonical 50k cap lives in utils/truncate.ts (lowest tier; core and tools
// both import from it). Re-exported here for prompt-layer consumers.
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../utils/truncate.js';
import { baselineText } from '../harness/text.js';
export { DEFAULT_MAX_RESULT_SIZE_CHARS };

// ---------------------------------------------------------------------------
// System prompt boundary
// ---------------------------------------------------------------------------

/** Marker that splits cacheable vs dynamic sections of the system prompt. */
export const PROMPT_CACHE_BOUNDARY = '__HALO_PROMPT_CACHE_BOUNDARY__';

// ---------------------------------------------------------------------------
// Model defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TOKENS = 16384;


// ---------------------------------------------------------------------------
// Tool-result budget
// ---------------------------------------------------------------------------

/** Per-result ingress limit; never a cumulative history budget. */
export const DEFAULT_TOOL_RESULT_BUDGET = DEFAULT_MAX_RESULT_SIZE_CHARS;

// ---------------------------------------------------------------------------
// Compact thresholds
// ---------------------------------------------------------------------------

export const AUTO_COMPACT_THRESHOLD = 0.9;
export const MAX_INPUT_TOKENS = 180_000;
export const TARGET_INPUT_TOKENS = 40_000;
/** apiCompact trigger threshold as a fraction of the model's context window. */
export const API_COMPACT_THRESHOLD_PCT = 0.9;
/** apiCompact trim target as a fraction of the model's context window. */
export const API_COMPACT_TARGET_PCT = 0.2;
export const KEEP_RECENT_MESSAGES = 10;
export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

// ---------------------------------------------------------------------------
// Bash tool defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Context window sizes
// ---------------------------------------------------------------------------

/**
 * Context window assumed when the host does not declare one via
 * `Options.contextWindow`.
 *
 * The SDK never infers the window from the model name: the caller knows which
 * endpoint it is talking to, and a wrong guess either overflows the request or
 * compacts away context that the model could still have used.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export const MAX_TOKENS_RECOVERY_LIMIT = 3;

/**
 * How many times a turn may end on an unreadable tool call before the loop
 * stops re-prompting. A model that cannot produce the protocol twice running
 * will not produce it on the third attempt either, and each retry costs a turn.
 */
export const UNREADABLE_TOOL_CALL_RETRY_LIMIT = 2;
export const MAX_TOKENS_RECOVERY_MSG = baselineText('context.recovery.max_tokens');

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

/**
 * Model turns an active goal may go unseen before the loop recites it. Long
 * runs push the goal far back in context, or out of it through the
 * sliding-window trim, without a full compaction to re-inject it.
 */
export const GOAL_RECITATION_INTERVAL = 25;
