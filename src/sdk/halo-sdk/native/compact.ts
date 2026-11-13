import type { AutoCompactState as AutoCompactStateContract, CompactOptions, CompactResult, PartialCompactOptions } from '../core/compact.js';
import type { ContentBlock, LlmProvider, Message, ProviderRequest, ProviderResponse, ToolResultBlock } from '../types/provider.js';
import type { ApiTokenAnchor } from '../utils/tokens.js';
import { runPublic } from './operation.js';
import { callbackError, loadBinding, nativeError, parseNativeValue, stringifyNativeValue } from './binding.js';
import { nativeProviderDescriptor } from './provider-identities.js';

function value<T>(method: string, args: unknown[]): T {
  try { return parseNativeValue(loadBinding().nativeValue(method, stringifyNativeValue(args))) as T; }
  catch (error) { throw nativeError(error); }
}

export function microCompact(messages: Message[], budget: number): { messages: Message[]; truncatedCount: number } {
  const receipt = value<{ messages: Message[]; truncatedCount: number; sameArray: boolean; copiedMessages: number[]; changedBlocks: [number, number][] }>('compact.micro', [messages, budget]);
  if (receipt.sameArray) return { messages, truncatedCount: receipt.truncatedCount };
  const result = messages.slice();
  for (const index of receipt.copiedMessages) result[index] = { ...messages[index], content: [...messages[index].content as ContentBlock[]] };
  for (const [message, block] of receipt.changedBlocks) {
    const content = result[message].content as ContentBlock[];
    content[block] = { ...content[block], content: (receipt.messages[message].content as ToolResultBlock[])[block].content } as ContentBlock;
  }
  return { messages: result, truncatedCount: receipt.truncatedCount };
}

export function apiCompact(messages: Message[], anchor?: ApiTokenAnchor, contextWindow?: number): Message[] | null {
  const total = anchor?.estimateWithAnchor(messages);
  const indices = value<number[] | null>('compact.api', [messages, total, contextWindow]);
  return indices?.map(index => messages[index]) ?? null;
}

export function formatCompactSummary(raw: string): string { return value('compact.format', [raw]); }
export function getCompactPrompt(customInstructions?: string): string { return value('compact.prompt', [customInstructions]); }
export function shouldAutoCompact(inputTokens: number, contextWindow: number, state: AutoCompactStateContract): boolean {
  return value('compact.shouldAuto', [inputTokens, contextWindow, state.disabled]);
}
export function calculateTokenWarningState(inputTokens: number, contextWindow: number): 'ok' | 'warning' | 'critical' {
  return value('compact.warning', [inputTokens, contextWindow]);
}

export class AutoCompactState {
  compactionCount = 0;
  consecutiveFailures = 0;
  disabled = false;
  onSuccess(): void { Object.assign(this, value('compact.state', [{ compactionCount: this.compactionCount, consecutiveFailures: this.consecutiveFailures, disabled: this.disabled }, 'success'])); }
  onFailure(): void { Object.assign(this, value('compact.state', [{ compactionCount: this.compactionCount, consecutiveFailures: this.consecutiveFailures, disabled: this.disabled }, 'failure'])); }
}

type MessageOrigin = { kind: 'history' | 'attachment'; index: number } | { kind: 'callback'; reference: string };
interface CompactReceipt extends CompactResult {
  origins: (MessageOrigin | null)[];
  arrayReference: string | null;
}

class CompactReferences {
  private readonly originals: Message[];
  private readonly references = new Map<string, object>();
  private readonly origins = new WeakMap<object, MessageOrigin>();
  private readonly identities = new WeakMap<object, string>();
  private nextReference = 0;

  constructor(private readonly history: Message[], private readonly attachments: Message[]) {
    this.originals = history.slice();
    this.originals.forEach((message, index) => this.origins.set(message, { kind: 'history', index }));
    attachments.forEach((message, index) => {
      if (!this.origins.has(message)) this.origins.set(message, { kind: 'attachment', index });
    });
  }

  snapshot(): Message[] {
    for (let index = this.originals.length; index < this.history.length; index++) {
      const message = this.history[index];
      this.originals.push(message);
      this.origins.set(message, { kind: 'history', index });
    }
    return this.history;
  }

  retain(value: object): string {
    let reference = this.identities.get(value);
    if (reference === undefined) {
      reference = String(++this.nextReference);
      this.identities.set(value, reference);
      this.references.set(reference, value);
    }
    return reference;
  }

  retained<T>(reference: string): T {
    if (!this.references.has(reference)) throw new Error('Compaction callback reference is no longer available');
    return this.references.get(reference) as T;
  }

  restore(messages: Message[], origins: (MessageOrigin | null)[], reference?: string | null): Message[] {
    if (reference === 'history') return this.history;
    if (reference != null) return this.retained<Message[]>(reference);
    return messages.map((message, index) => {
      const origin = origins[index];
      if (!origin) return message;
      if (origin.kind === 'callback') return this.retained<Message>(origin.reference);
      return (origin.kind === 'history' ? this.originals : this.attachments)[origin.index];
    });
  }

  capture(messages: Message[]) {
    return { value: messages, reference: this.retain(messages), origins: messages.map(message => {
      const origin = this.origins.get(message);
      if (origin) return origin;
      const captured: MessageOrigin = { kind: 'callback', reference: this.retain(message) };
      this.origins.set(message, captured);
      return captured;
    }) };
  }

  result(result: CompactReceipt | null): CompactResult | null {
    if (result === null) return null;
    return { messages: this.restore(result.messages, result.origins, result.arrayReference),
      summary: result.summary, tokensFreed: result.tokensFreed };
  }
}

function configuration(messages: Message[], attachments: Message[], provider: LlmProvider, options: CompactOptions | undefined) {
  const { signal: _signal, estimateInputTokens, prepareCandidate, onResponse, ...plain } = options ?? {};
  const references = new CompactReferences(messages, attachments);
  return { references, options: { provider, helperOptions: plain, helperCallbacks: {
    ...(!nativeProviderDescriptor(provider) ? { complete: async (request: ProviderRequest) => {
      try {
        const response = await provider.createMessage(request);
        return { request, response, reference: references.retain(response) };
      } catch (error) { return { request, error: JSON.parse(callbackError(error)) }; }
    } } : {}),
    ...(estimateInputTokens ? { estimate: (history: Message[], origins: (MessageOrigin | null)[], reference: string | null) => ({
      value: estimateInputTokens(references.restore(history, origins, reference)),
    }) } : {}),
    ...(prepareCandidate ? { prepare: (history: Message[], origins: (MessageOrigin | null)[], reference: string | null) => {
      const candidate = references.restore(history, origins, reference);
      return references.capture(prepareCandidate(candidate) ?? candidate);
    } } : {}),
    ...(onResponse ? { response: (response: ProviderResponse, reference: string | null) => {
      const original = reference == null ? response : references.retained<ProviderResponse>(reference);
      onResponse(original);
      return { value: original };
    } } : {}),
    snapshot: () => references.snapshot(),
  } } };
}

export async function fullCompact(messages: Message[], provider: LlmProvider, model: string, _systemPrompt: string,
  attachments: Message[] = [], customInstructions?: string, transcriptPath?: string, options?: CompactOptions): Promise<CompactResult> {
  const config = configuration(messages, attachments, provider, options);
  return runPublic('compact.full', config.options,
    { messages, model, attachments, instructions: customInstructions, transcriptPath }, options?.signal,
    { result: (result: CompactReceipt) => config.references.result(result)! });
}

export async function partialCompact(messages: Message[], options: PartialCompactOptions): Promise<CompactResult> {
  const { provider, model, ...plain } = options;
  const config = configuration(messages, options.attachments ?? [], provider, plain);
  return runPublic('compact.partial', config.options, { messages, model }, options.signal,
    { result: (result: CompactReceipt) => config.references.result(result)! });
}

export async function autoCompactIfNeeded(messages: Message[], inputTokens: number, contextWindow: number, model: string,
  provider: LlmProvider, _systemPrompt: string, state: AutoCompactStateContract, attachments: Message[] = [], transcriptPath?: string, options?: CompactOptions): Promise<CompactResult | null> {
  const disabled = state.disabled;
  if (!value<boolean>('compact.shouldAuto', [inputTokens, contextWindow, disabled])) return null;
  const config = configuration(messages, attachments, provider, options);
  return runPublic('compact.auto', { ...config.options, stateCallbacks: {
    success: () => state.onSuccess(),
    failure: () => { state.onFailure(); return { consecutiveFailures: state.consecutiveFailures, disabled: state.disabled }; },
  } }, { messages, model, inputTokens, contextWindow, disabled, attachments, transcriptPath }, options?.signal,
    { result: (result: CompactReceipt | null) => config.references.result(result) });
}
