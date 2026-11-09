import type { QueryConfig } from '../../types/config.js';
import type { Message } from '../../types/provider.js';
import type { Tool } from '../../types/tool.js';
import { readToolContextSnapshot } from './history.js';
import { ToolDiscoveryState } from './state.js';

/** Session owners call once after tool filtering and native history restoration. */
export function prepareToolContext(
  config: QueryConfig, tools: readonly Tool[], history: readonly Message[], legacyHistory = false,
): ToolDiscoveryState | null {
  const previous = readToolContextSnapshot(history);
  const native = config.toolCallingMode === 'native';
  if ((!native && !previous) || (!config.toolDiscovery && !previous) || (legacyHistory && !previous)) return null;
  const state = new ToolDiscoveryState(tools, native ? config.toolDiscovery ?? { services: {} } : { services: {} },
    config.toolResultBudget, Math.max(0, config.contextWindow - config.maxTokens), config.disallowedTools,
    native && previous?.discoveryEntries === true);
  if (previous) state.restore(previous);
  return state;
}

/** Reconcile a real catalog change without replaying the whole conversation. */
export function refreshToolContext(config: QueryConfig, tools: readonly Tool[], previous: ToolDiscoveryState): ToolDiscoveryState {
  const snapshot = previous.snapshot();
  const native = config.toolCallingMode === 'native';
  const state = new ToolDiscoveryState(tools, native ? config.toolDiscovery ?? { services: {} } : { services: {} }, config.toolResultBudget,
    Math.max(0, config.contextWindow - config.maxTokens), config.disallowedTools, native && snapshot.discoveryEntries);
  if (state.catalog.generation === previous.catalog.generation) return previous;
  state.restore(snapshot);
  return state;
}
