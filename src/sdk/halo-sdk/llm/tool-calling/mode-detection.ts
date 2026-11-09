/**
 * @module llm/tool-calling/mode-detection
 * Resolves the tool calling mode for a given model.
 *
 * Priority:
 *   1. Explicit options.toolCallingMode — always wins.
 *   2. Model-family defaults — detected from model name prefix.
 *   3. Fallback to 'native' for unrecognized models.
 *
 * TODO: Replace hardcoded prefix matching with ModelAdapter.preferredToolCallingMode().
 * @license MIT
 */

import type { ToolCallingMode, ModelFamily } from './types.js';

// ---------------------------------------------------------------------------
// Model family prefix table
// ---------------------------------------------------------------------------

/** Each entry: (prefixes, family, default ToolCallingMode) */
const FAMILY_TABLE: Array<{
  prefixes: string[];
  family: ModelFamily;
  mode: ToolCallingMode;
}> = [
  { prefixes: ['claude'],                         family: 'anthropic', mode: 'native'   },
  { prefixes: ['gpt', 'o1', 'o3', 'o4', 'chatgpt'], family: 'openai',   mode: 'native'   },
  { prefixes: ['gemini'],                         family: 'google',    mode: 'native'   },
  { prefixes: ['deepseek'],                       family: 'deepseek',  mode: 'native' },
  { prefixes: ['qwen'],                           family: 'qwen',      mode: 'native' },
  { prefixes: ['glm', 'chatglm'],                 family: 'glm',       mode: 'native'     },
  { prefixes: ['kimi', 'moonshot'],               family: 'kimi',      mode: 'native' },
  { prefixes: ['minimax', 'abab'],                family: 'minimax',   mode: 'native' },
];

// ---------------------------------------------------------------------------
// normalizeModelName
// ---------------------------------------------------------------------------

/**
 * Normalize a model identifier for matching.
 *
 * Model IDs can include arbitrary provider paths and segments
 * (e.g. `Pro/zai-org/GLM-5`, `openrouter/deepseek/deepseek-chat`).
 * The model name proper is always the last path segment, so we lowercase
 * and keep only that segment — {@link matchesPrefix} then matches strictly
 * within it.
 */
function normalizeModelName(model: string): string {
  const lower = model.toLowerCase().trim();
  const lastSlash = lower.lastIndexOf('/');
  return lastSlash === -1 ? lower : lower.slice(lastSlash + 1);
}

// ---------------------------------------------------------------------------
// detectModelFamily
// ---------------------------------------------------------------------------

/**
 * Returns true when `name` matches the given prefix.
 *
 * A match is accepted when:
 *   - `name` exactly equals `prefix`, OR
 *   - `name` starts with `prefix` AND the next character is a separator
 *     (`-`, `:`, `.`) or a digit (handles e.g. `qwen2.5-72b`, `chatglm3-6b`,
 *     `abab6.5s-chat`).
 */
function matchesPrefix(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false;
  if (name.length === prefix.length) return true;
  const next = name[prefix.length];
  return next === '-' || next === ':' || next === '.' || (next >= '0' && next <= '9');
}

/**
 * Detect the model family from a model identifier.
 *
 * Handles `provider/model` notation by stripping the provider prefix first.
 *
 * TODO: used by ModelAdapter registry.
 */
export function detectModelFamily(model: string): ModelFamily {
  const name = normalizeModelName(model);

  for (const { prefixes, family } of FAMILY_TABLE) {
    for (const prefix of prefixes) {
      if (matchesPrefix(name, prefix)) {
        return family;
      }
    }
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// resolveToolCallingMode
// ---------------------------------------------------------------------------

/**
 * Determine the tool calling mode to use for a model.
 *
 * @param model   - The resolved model identifier (e.g. "deepseek-r1", "glm-4.6").
 * @param options - Optional overrides from the caller.
 * @returns The resolved ToolCallingMode — never undefined.
 */
export function resolveToolCallingMode(
  model: string,
  options?: { toolCallingMode?: ToolCallingMode },
): ToolCallingMode {
  // 1. Explicit caller override always wins.
  if (options?.toolCallingMode) {
    return options.toolCallingMode;
  }

  // 2. Model-family default.
  const name = normalizeModelName(model);
  for (const { prefixes, mode } of FAMILY_TABLE) {
    for (const prefix of prefixes) {
      if (matchesPrefix(name, prefix)) {
        return mode;
      }
    }
  }

  // 3. Unknown model — default (safe-side strategy).
  return 'native';
}
