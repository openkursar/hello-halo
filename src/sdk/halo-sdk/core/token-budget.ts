/**
 * @module core/token-budget
 * Context-window budget tracking.
 * @license MIT
 */

import { createHash } from 'node:crypto';
import type {
  Message,
  ProviderRequest,
  SystemPromptBlock,
  ToolDefinition,
  UsageInfo,
} from '../types/provider.js';
import { estimateMessageTokens, estimateTokens } from '../utils/tokens.js';
import { AUTO_COMPACT_THRESHOLD } from '../prompt/constants.js';

export type BudgetRequest = Pick<ProviderRequest, 'messages' | 'systemPrompt' | 'tools'> &
  Partial<Pick<ProviderRequest, 'model' | 'thinking'>>;

// Provider tokenizers and request framing differ; local counts need headroom.
const LOCAL_ESTIMATE_MARGIN = 1.2;
const DEFAULT_OUTPUT_RESERVATION = 20_000;
const MIN_ANSWER_RESERVATION = 1024;

/** Preserve the thinking budget the provider could send under the configured ceiling. */
export function effectiveThinking(
  thinking: ProviderRequest['thinking'],
  maxTokens: number,
): ProviderRequest['thinking'] {
  return thinking?.type === 'enabled'
    ? { ...thinking, budgetTokens: Math.min(thinking.budgetTokens, Math.max(0, maxTokens - 1)) }
    : thinking;
}

/** A maintenance allowance, not a model limit or the user's answer ceiling. */
export function maintenanceOutputBudget(contextWindow: number, thinking?: ProviderRequest['thinking']): number {
  const textBudget = Math.min(DEFAULT_OUTPUT_RESERVATION, Math.max(1, Math.floor(contextWindow / 4)));
  return Math.min(contextWindow - 1, textBudget + (thinking?.type === 'enabled' ? thinking.budgetTokens : 0));
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Cache hits save billing work, but still occupy the model's context window. */
export function contextInputTokens(usage: UsageInfo | undefined): number {
  let total = 0;
  for (const value of [usage?.input_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens]) {
    if (isTokenCount(value)) total = Math.min(Number.MAX_VALUE, total + value);
  }
  return total;
}

function hasCompleteInputUsage(usage: UsageInfo | undefined): usage is UsageInfo {
  return isTokenCount(usage?.input_tokens) &&
    (usage?.cache_creation_input_tokens === undefined || isTokenCount(usage.cache_creation_input_tokens)) &&
    (usage?.cache_read_input_tokens === undefined || isTokenCount(usage.cache_read_input_tokens));
}

function messageKey(message: Message): string {
  return createHash('sha256').update(JSON.stringify({ ...message, content: typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }] : message.content },
  (key, value) => key === 'cache_control' ? undefined : value)).digest('hex');
}

interface RequestAnchor extends BudgetRequest {
  inputTokens: number;
  localTokens: number;
}

/**
 * Budgets the complete model input independently of billing usage.
 * Message content, system blocks and tool definitions must be immutable between
 * calls; reset after rewriting history or mutating those objects in place.
 */
export class TokenBudget {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;

  private messageEstimates = new WeakMap<Message, number>();
  private messageKeys = new WeakMap<Message, string>();
  private systemEstimates = new WeakMap<SystemPromptBlock, number>();
  private toolEstimates = new WeakMap<ToolDefinition, number>();
  private toolKeys = new WeakMap<ToolDefinition, string>();
  private systemText: { text: string; tokens: number } | undefined;
  private anchor: RequestAnchor | undefined;
  private pendingInputTokens: number | undefined;
  private thinking: ProviderRequest['thinking'];
  private outputTokenLimit: number | undefined;

  constructor(contextWindow: number, maxOutputTokens = 16384) {
    this.contextWindow = contextWindow;
    this.maxOutputTokens = maxOutputTokens;
  }

  configureOutput(thinking: ProviderRequest['thinking'], outputTokenLimit?: number): void {
    this.thinking = thinking;
    this.outputTokenLimit = outputTokenLimit;
  }

  get outputReservationTokens(): number {
    const ceiling = Math.min(this.maxOutputTokens, this.outputTokenLimit ?? Infinity);
    const thinkingTokens = this.thinking?.type === 'enabled' ? this.thinking.budgetTokens : 0;
    const answerTokens = Math.min(MIN_ANSWER_RESERVATION, Math.max(1, ceiling - thinkingTokens));
    return Math.min(ceiling, Math.max(
      Math.min(DEFAULT_OUTPUT_RESERVATION, Math.max(1, Math.floor(this.contextWindow / 4))),
      thinkingTokens > 0 ? thinkingTokens + answerTokens : 0,
    ));
  }

  /** Zero means input recovery is required; never pass it to a provider. */
  requestMaxTokens(inputTokens: number, ceiling = this.maxOutputTokens): number {
    return Math.max(0, Math.min(ceiling, this.outputTokenLimit ?? Infinity,
      Math.floor(this.contextWindow - inputTokens)));
  }

  get availableInputTokens(): number {
    return Math.max(0, this.contextWindow - this.outputReservationTokens);
  }

  get targetInputTokens(): number {
    return Math.floor(this.availableInputTokens * 0.55);
  }

  estimateRequest(request: BudgetRequest): number {
    const localTokens = this.estimateLocalRequest(request);
    const anchor = this.anchor;
    if (!anchor || request.model !== anchor.model || JSON.stringify(request.thinking) !== JSON.stringify(anchor.thinking) ||
      request.messages.length < anchor.messages.length ||
      !anchor.messages.every((message, index) => message === request.messages[index] ||
        this.messageKey(message) === this.messageKey(request.messages[index])) ||
      (request.tools?.length ?? 0) < (anchor.tools?.length ?? 0) ||
      !(anchor.tools ?? []).every((tool, index) => tool === request.tools![index] ||
        this.toolKey(tool) === this.toolKey(request.tools![index]))) return localTokens;
    if (typeof anchor.systemPrompt === 'string') {
      if (typeof request.systemPrompt !== 'string' ||
        (request.systemPrompt !== anchor.systemPrompt && !request.systemPrompt.startsWith(anchor.systemPrompt))) {
        return localTokens;
      }
    } else if (anchor.systemPrompt?.length &&
      (!Array.isArray(request.systemPrompt) || request.systemPrompt.length < anchor.systemPrompt.length ||
        !anchor.systemPrompt.every((block, index) => block.text === (request.systemPrompt as SystemPromptBlock[])[index].text))) {
      return localTokens;
    }
    // Only the new content grows: a ratio would multiply fixed prompt overhead.
    // A smaller candidate belongs to a rewrite, not to the observed request.
    if (localTokens < anchor.localTokens) return localTokens;
    return Math.min(Number.MAX_VALUE, anchor.inputTokens + (localTokens - anchor.localTokens));
  }

  observe(request: BudgetRequest, usage: UsageInfo | undefined): void {
    if (!hasCompleteInputUsage(usage)) return;
    const inputTokens = contextInputTokens(usage);
    if (inputTokens <= 0) return;
    this.anchor = {
      inputTokens,
      model: request.model,
      thinking: request.thinking ? { ...request.thinking } : undefined,
      localTokens: this.estimateLocalRequest(request),
      messages: request.messages.slice(),
      systemPrompt: Array.isArray(request.systemPrompt) ? request.systemPrompt.slice() : request.systemPrompt,
      tools: request.tools?.slice(),
    };
    this.pendingInputTokens = undefined;
  }

  get compactionTriggerTokens(): number {
    return Math.floor(this.availableInputTokens * AUTO_COMPACT_THRESHOLD);
  }

  shouldCompactRequest(request: BudgetRequest): boolean {
    return this.estimateRequest(request) >= this.compactionTriggerTokens;
  }

  /** Drops calibration and cached content estimates after a history rewrite. */
  reset(): void {
    this.anchor = undefined;
    this.pendingInputTokens = undefined;
    this.messageEstimates = new WeakMap();
    this.messageKeys = new WeakMap();
    this.systemEstimates = new WeakMap();
    this.toolEstimates = new WeakMap();
    this.toolKeys = new WeakMap();
    this.systemText = undefined;
  }

  /** Legacy count-only input anchors the next messages-only estimate; prefer observe. */
  updateFromUsage(inputTokens: number): void {
    if (isTokenCount(inputTokens) && inputTokens > 0) this.pendingInputTokens = inputTokens;
  }

  currentInputTokens(messages: Message[]): number {
    const request = { messages };
    if (this.pendingInputTokens !== undefined) {
      this.observe(request, { input_tokens: this.pendingInputTokens, output_tokens: 0 });
    }
    return this.estimateRequest(request);
  }

  remainingInputTokens(messages: Message[]): number {
    return Math.max(0, this.availableInputTokens - this.currentInputTokens(messages));
  }

  usageRatio(messages: Message[]): number {
    if (this.availableInputTokens <= 0) return 1;
    return Math.min(1, this.currentInputTokens(messages) / this.availableInputTokens);
  }

  shouldCompact(messages: Message[]): boolean {
    return this.usageRatio(messages) >= AUTO_COMPACT_THRESHOLD;
  }

  summary(messages: Message[]): string {
    const used = this.currentInputTokens(messages);
    const pct = (this.usageRatio(messages) * 100).toFixed(1);
    return `${used.toLocaleString()} / ${this.contextWindow.toLocaleString()} tokens (${pct}%)`;
  }

  private messageKey(message: Message): string {
    let key = this.messageKeys.get(message);
    if (key === undefined) {
      key = messageKey(message);
      this.messageKeys.set(message, key);
    }
    return key;
  }

  private toolKey(tool: ToolDefinition): string {
    let key = this.toolKeys.get(tool);
    if (key === undefined) {
      key = createHash('sha256').update(JSON.stringify(tool)).digest('hex');
      this.toolKeys.set(tool, key);
    }
    return key;
  }

  private estimateLocalRequest(request: BudgetRequest): number {
    let total = 0;
    for (const message of request.messages) {
      let tokens = this.messageEstimates.get(message);
      if (tokens === undefined) {
        tokens = Math.ceil(estimateMessageTokens([message]) * LOCAL_ESTIMATE_MARGIN);
        this.messageEstimates.set(message, tokens);
      }
      total += tokens;
    }

    if (typeof request.systemPrompt === 'string') {
      if (this.systemText?.text !== request.systemPrompt) {
        this.systemText = { text: request.systemPrompt, tokens: this.estimateSystemText(request.systemPrompt) };
      }
      total += this.systemText.tokens;
    } else {
      for (const block of request.systemPrompt ?? []) {
        let tokens = this.systemEstimates.get(block);
        if (tokens === undefined) {
          tokens = this.estimateSystemText(block.text);
          this.systemEstimates.set(block, tokens);
        }
        total += tokens;
      }
    }

    for (const tool of request.tools ?? []) {
      let tokens = this.toolEstimates.get(tool);
      if (tokens === undefined) {
        tokens = Math.ceil((estimateTokens(JSON.stringify(tool)) + 4) * LOCAL_ESTIMATE_MARGIN);
        this.toolEstimates.set(tool, tokens);
      }
      total += tokens;
    }
    return total;
  }

  private estimateSystemText(text: string): number {
    return text ? Math.ceil((estimateTokens(text) + 4) * LOCAL_ESTIMATE_MARGIN) : 0;
  }
}
