/**
 * @module core/context
 * Resolves user-supplied Options into the QueryConfig the loop runs against.
 * @license MIT
 */

import type { ModelInfo, Options, QueryConfig, ThinkingConfig } from '../types/config.js';
import { snapshotSkillCatalog } from '../skills/index.js';
import { snapshotToolDiscoveryOptions } from './tool-context/config.js';
import { resolveConventions } from './conventions.js';
import { resolveToolCallingMode } from '../llm/tool-calling/index.js';
import { BETA_CONTEXT_1M } from '../llm/anthropic-betas.js';
import { getLogger } from '../utils/logger.js';
import { resolveSessionReadDenyRoots } from './read-policy.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_TOOL_RESULT_BUDGET } from '../prompt/constants.js';

const log = getLogger('Context');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_MAX_TURNS = 100;
const DEFAULT_MAX_BUDGET_USD = Infinity;

// ---------------------------------------------------------------------------
// resolveQueryConfig — Options → QueryConfig with defaults
// ---------------------------------------------------------------------------

/**
 * Resolve the thinking configuration from Options.
 *
 * Priority: explicit `thinking` config > deprecated `maxThinkingTokens` > disabled.
 */
function resolveThinking(options: Options): ThinkingConfig {
  // Explicit thinking config always wins
  if (options.thinking) return options.thinking;

  // Deprecated maxThinkingTokens fallback (consumer uses this)
  return thinkingForBudget(options.maxThinkingTokens, options.adaptiveThinking ?? false);
}

/**
 * The models this query can run on: the ones the host configured. The SDK
 * keeps no catalog of its own.
 */
export function configuredModels(
  config: Pick<QueryConfig, 'model' | 'fallbackModel'>,
): ModelInfo[] {
  const ids = [config.model, config.fallbackModel]
    .filter((id): id is string => !!id);
  return [...new Set(ids)].map((id) => ({ value: id, displayName: id, description: '' }));
}

/**
 * Map a thinking token budget to a thinking config. A zero or missing budget
 * turns thinking off; otherwise `adaptive` decides whether the budget is sent
 * or the model thinks adaptively.
 */
export function thinkingForBudget(
  budget: number | null | undefined,
  adaptive: boolean,
): ThinkingConfig {
  if (budget == null || budget <= 0) return { type: 'disabled' };
  return adaptive ? { type: 'adaptive' } : { type: 'enabled', budgetTokens: budget };
}

/**
 * Resolve the context window the session will budget against.
 *
 * The host declares it; the SDK never guesses from the model name. Requesting
 * the 1M-context beta without raising the declared window is contradictory —
 * the request would be allowed to grow past what compaction is defending, so
 * say so rather than silently picking one of the two.
 */
function resolveContextWindow(options: Options): number {
  if (options.contextWindow && options.contextWindow > 0) {
    return options.contextWindow;
  }
  if (options.betas?.includes(BETA_CONTEXT_1M)) {
    log.warn(
      'betas requests the 1M context window but Options.contextWindow was not raised; ' +
      `budgeting against the ${DEFAULT_CONTEXT_WINDOW}-token default`,
    );
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolve user-provided Options into a fully populated QueryConfig.
 * Fills in defaults for any unset fields.
 */
export function resolveQueryConfig(options: Options): QueryConfig {
  const abortController = options.abortController ?? new AbortController();
  const model = options.model;
  if (!model) {
    throw new Error('Options.model is required; the SDK does not pick a model on its own.');
  }

  return {
    skillCatalog: options.skillCatalog === undefined ? undefined : snapshotSkillCatalog(options.skillCatalog),
    model,
    maxTokens: options.maxOutputTokens && options.maxOutputTokens > 0
      ? options.maxOutputTokens
      : DEFAULT_MAX_TOKENS,
    contextWindow: resolveContextWindow(options),
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    modelPricing: options.modelPricing ?? {},
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? {},
    systemPrompt: options.systemPrompt ?? { type: 'preset', preset: 'default' },
    promptProfile: options.promptProfile,
    thinking: resolveThinking(options),
    thinkingExplicit: options.thinking !== undefined || options.maxThinkingTokens !== undefined,
    adaptiveThinking: options.adaptiveThinking ?? false,
    effort: options.effort ?? 'high',
    toolResultBudget: options.toolResultBudget ?? DEFAULT_TOOL_RESULT_BUDGET,
    includePartialMessages: options.includePartialMessages ?? false,
    permissionMode: options.permissionMode ?? 'default',
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    readDenyRoots: resolveSessionReadDenyRoots(options),
    mcpServers: options.mcpServers,
    toolDiscovery: snapshotToolDiscoveryOptions(options.toolDiscovery),
    hooks: options.hooks,
    canUseTool: options.canUseTool,
    abortSignal: abortController.signal,
    fallbackModel: options.fallbackModel,
    betas: options.betas,
    taskBudget: options.taskBudget,
    additionalDirectories: options.additionalDirectories,
    settingSources: options.settingSources,
    conventions: resolveConventions(options.conventions),
    toolCallingMode: resolveToolCallingMode(model, { toolCallingMode: options.toolCallingMode }),
    turnEndChecks: {
      openWork: options.turnEndChecks?.openWork ?? true,
      completion: options.turnEndChecks?.completion ?? false,
    },
  };
}
