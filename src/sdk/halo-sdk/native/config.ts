import { homedir, tmpdir } from 'node:os';
import type { Options, QueryConfig } from '../types/config.js';
import { readDenyFloor } from '../core/read-policy.js';
import type { AgentConventions } from '../core/conventions.js';
import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue } from './binding.js';

let conventions: AgentConventions | undefined;
const fields = ['skillCatalog', 'model', 'maxOutputTokens', 'contextWindow', 'maxTurns', 'maxBudgetUsd', 'modelPricing', 'cwd', 'env',
  'systemPrompt', 'promptProfile', 'ultraEffort', 'thinking', 'maxThinkingTokens', 'adaptiveThinking', 'effort', 'toolResultBudget', 'includePartialMessages',
  'permissionMode', 'allowedTools', 'disallowedTools', 'toolDiscovery', 'fallbackModel', 'betas', 'taskBudget', 'additionalDirectories',
  'settingSources', 'conventions', 'toolCallingMode', 'turnEndChecks', 'harnessText'] as const;

export function resolveQueryConfig(options: Options): QueryConfig {
  const controller = options.abortController ?? new AbortController();
  const data = Object.fromEntries(fields.map(key => [key, options[key]]));
  Object.assign(data, { nativeReadDenyRoots: readDenyFloor(options), nativeProcessEnv: { ...process.env }, nativeProcessCwd: process.cwd(), nativeHomeDirectory: homedir(), nativeTempDirectory: tmpdir(),
    ...(options.codeSearch ? { codeSearch: { cachePath: options.codeSearch.cachePath } } : {}) });
  let result: QueryConfig;
  try {
    result = parseNativeValue(loadBinding().nativeValue('resolveQueryConfig', stringifyNativeValue([data]))) as QueryConfig;
    conventions ??= parseNativeValue(loadBinding().nativeValue('config.defaultConventions', '[]')) as AgentConventions;
  } catch (error) { throw nativeError(error); }
  for (const key of ['modelPricing', 'env', 'systemPrompt'] as const) if (options[key] != null) (result as unknown as Record<string, unknown>)[key] = options[key];
  for (const key of ['promptProfile', 'allowedTools', 'disallowedTools', 'mcpServers', 'hooks', 'canUseTool', 'betas', 'taskBudget', 'additionalDirectories', 'settingSources'] as const) {
    (result as unknown as Record<string, unknown>)[key] = options[key];
  }
  if (options.thinking) result.thinking = options.thinking;
  result.abortSignal = controller.signal;
  result.conventions = options.conventions ? { ...conventions, ...options.conventions } : conventions;
  if (result.skillCatalog) result.skillCatalog = Object.freeze(result.skillCatalog.map(entry => Object.freeze({ ...entry, source: Object.freeze(entry.source) })));
  return result;
}
