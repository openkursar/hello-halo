import type { CostTracker as CostTrackerContract, ModelPricingTable, ModelUsageEntry } from '../core/cost.js';
import type { TokenBudget as TokenBudgetContract, BudgetRequest } from '../core/token-budget.js';
import type { Message, ProviderRequest, UsageInfo } from '../types/provider.js';
import type { PromptProfile } from '../prompt/profiles/index.js';
import type { PromptProfileSelection, HarnessTextTemplate } from '../types/config.js';
import type { SystemPromptConfig } from '../prompt/system-prompt.js';
import type { BuiltinSkillDefinition } from '../skills/builtins.js';
import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue, type NativeValueHandle } from './binding.js';

function invoke<T>(handle: NativeValueHandle, method: string, args: unknown[] = []): T {
  try { return parseNativeValue(handle.call(method, stringifyNativeValue(args))) as T; }
  catch (error) { throw nativeError(error); }
}

function value<T>(name: string, args: unknown[]): T {
  try { return parseNativeValue(loadBinding().nativeValue(name, stringifyNativeValue(args))) as T; }
  catch (error) { throw nativeError(error); }
}

export type CostTracker = CostTrackerContract;
export const CostTracker = class CostTracker {
  private readonly handle: NativeValueHandle;
  constructor(model: string, contextWindow = 200_000, pricingTable: ModelPricingTable = {},
    private readonly onUsage?: (usage: ModelUsageEntry, model: string) => void) {
    this.handle = new (loadBinding().NativeCostTracker)(model, contextWindow, stringifyNativeValue(pricingTable));
  }
  setModel(model: string): void { invoke(this.handle, 'setModel', [model]); }
  add(usage: UsageInfo | undefined, model?: string): void {
    const receipt = invoke<ModelUsageEntry>(this.handle, 'add', [usage, model]);
    this.onUsage?.(receipt, model ?? 'unknown');
  }
  addReportedUsage(entries: Record<string, ModelUsageEntry>): void { invoke(this.handle, 'addReportedUsage', [entries]); }
  get totalCostUsd(): number { return invoke(this.handle, 'totalCostUsd'); }
  get totalInputTokens(): number { return invoke(this.handle, 'totalInputTokens'); }
  get totalOutputTokens(): number { return invoke(this.handle, 'totalOutputTokens'); }
  get totalCacheCreationTokens(): number { return invoke(this.handle, 'totalCacheCreationTokens'); }
  get totalCacheReadTokens(): number { return invoke(this.handle, 'totalCacheReadTokens'); }
  get totalTokens(): number { return invoke(this.handle, 'totalTokens'); }
  isOverBudget(maxBudgetUsd: number): boolean { return invoke(this.handle, 'isOverBudget', [maxBudgetUsd]); }
  reset(): void { invoke(this.handle, 'reset'); }
  getUsage(): ReturnType<CostTrackerContract['getUsage']> { return invoke(this.handle, 'getUsage'); }
  getModelUsage(): Record<string, ModelUsageEntry> { return invoke(this.handle, 'getModelUsage'); }
  addChildCost(child: CostTrackerContract): void {
    invoke(this.handle, 'addChildCost', [{ usage: child.getUsage(), cost: child.totalCostUsd, models: child.getModelUsage() }]);
  }
  summary(): string { return invoke(this.handle, 'summary'); }
} as unknown as typeof CostTrackerContract;
export function wrapCostTracker(handle: NativeValueHandle, onUsage?: (usage: ModelUsageEntry, model: string) => void): CostTrackerContract {
  const tracker = Object.create(CostTracker.prototype) as CostTrackerContract;
  Object.defineProperty(tracker, 'handle', { value: handle });
  if (onUsage) Object.defineProperty(tracker, 'onUsage', { value: onUsage });
  return tracker;
}

export type TokenBudget = TokenBudgetContract;
const tokenBudgetHandles = new WeakMap<object, NativeValueHandle>();
class NativeTokenBudget {
  private readonly handle: NativeValueHandle;
  constructor(contextWindow: number, maxOutputTokens = 16_384, handle?: NativeValueHandle) {
    this.handle = handle ?? new (loadBinding().NativeTokenBudget)(contextWindow, maxOutputTokens);
    tokenBudgetHandles.set(this, this.handle);
  }
  get contextWindow(): number { return invoke(this.handle, 'contextWindow'); }
  get maxOutputTokens(): number { return invoke(this.handle, 'maxOutputTokens'); }
  configureOutput(thinking: ProviderRequest['thinking'], outputTokenLimit?: number): void { invoke(this.handle, 'configureOutput', [thinking, outputTokenLimit]); }
  get outputReservationTokens(): number { return invoke(this.handle, 'outputReservationTokens'); }
  requestMaxTokens(inputTokens: number, ceiling = this.maxOutputTokens): number { return invoke(this.handle, 'requestMaxTokens', [inputTokens, ceiling]); }
  get availableInputTokens(): number { return invoke(this.handle, 'availableInputTokens'); }
  get targetInputTokens(): number { return invoke(this.handle, 'targetInputTokens'); }
  estimateRequest(request: BudgetRequest): number { return invoke(this.handle, 'estimateRequest', [request]); }
  observe(request: BudgetRequest, usage: UsageInfo | undefined): void { invoke(this.handle, 'observe', [request, usage]); }
  get compactionTriggerTokens(): number { return invoke(this.handle, 'compactionTriggerTokens'); }
  shouldCompactRequest(request: BudgetRequest): boolean { return invoke(this.handle, 'shouldCompactRequest', [request]); }
  reset(): void { invoke(this.handle, 'reset'); }
  updateFromUsage(inputTokens: number): void { invoke(this.handle, 'updateFromUsage', [inputTokens]); }
  currentInputTokens(messages: Message[]): number { return invoke(this.handle, 'currentInputTokens', [messages]); }
  remainingInputTokens(messages: Message[]): number { return invoke(this.handle, 'remainingInputTokens', [messages]); }
  usageRatio(messages: Message[]): number { return invoke(this.handle, 'usageRatio', [messages]); }
  shouldCompact(messages: Message[]): boolean { return invoke(this.handle, 'shouldCompact', [messages]); }
  summary(messages: Message[]): string {
    const metrics = invoke<{ used: number; window: number; percent: string }>(this.handle, 'summaryMetrics', [messages]);
    return invoke(this.handle, 'formatSummary', [metrics.used.toLocaleString(), metrics.window.toLocaleString(), metrics.percent]);
  }
}
export const TokenBudget = NativeTokenBudget as unknown as typeof TokenBudgetContract;
export function tokenBudgetHandle(budget: TokenBudgetContract): NativeValueHandle | undefined { return tokenBudgetHandles.get(budget); }
export function wrapTokenBudget(handle: NativeValueHandle): TokenBudgetContract { return new NativeTokenBudget(0, 0, handle) as unknown as TokenBudgetContract; }

export function estimateTokens(text: string): number {
  try { return loadBinding().estimateTokensText(text); }
  catch (error) { throw nativeError(error); }
}
export function estimateMessageTokens(messages: Message[]): number { return value('estimateMessageTokens', [messages]); }
export function truncateToolResult(content: string, budget = 50_000): string {
  try { return loadBinding().truncateToolResultText(content, budget); }
  catch (error) { throw nativeError(error); }
}
export function splitAtBoundary(prompt: string): [string, string] {
  try {
    const [stableEnd, dynamicStart] = loadBinding().splitAtBoundaryRanges(prompt);
    return [prompt.slice(0, stableEnd), prompt.slice(dynamicStart)];
  }
  catch (error) { throw nativeError(error); }
}
export function assembleSystemPrompt(config: SystemPromptConfig): string {
  return value('assembleSystemPrompt', [{ ...config, nativeProcessEnv: { ...process.env }, tools: config.tools.map(tool => ({ name: tool.name })) }]);
}

const profiles = new Map<string, PromptProfile>();
export function resolvePromptProfile(model: string, selection?: PromptProfileSelection): PromptProfile {
  const profile = value<PromptProfile>('resolvePromptProfile', [model, selection]);
  let saved = profiles.get(profile.id);
  if (!saved) { saved = Object.freeze(profile); profiles.set(profile.id, saved); }
  return saved;
}

export function getHarnessTextCatalog(): HarnessTextTemplate[] { return value('harness.catalog', []); }
let builtinSkills: readonly BuiltinSkillDefinition[] | undefined;
export function getBuiltinSkillDefinitions(): readonly BuiltinSkillDefinition[] {
  builtinSkills ??= Object.freeze(value<BuiltinSkillDefinition[]>('skills.builtinDefinitions', []).map(definition => Object.freeze(definition)));
  return builtinSkills;
}
