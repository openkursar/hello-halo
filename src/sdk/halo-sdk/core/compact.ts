/**
 * @module core/compact
 * Context summarization and explicit history-reduction utilities.
 * @license MIT
 */

import { getLogger } from '../utils/logger.js';
import { CompactError, isContextWindowExceededError } from '../utils/errors.js';
import { createHash } from 'node:crypto';
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from '../prompt/summary.js';
import { resolvePromptProfile } from '../prompt/profiles/index.js';
import type { PromptProfileSelection } from '../types/config.js';
import type { Message, ContentBlock, ToolResultBlock, LlmProvider, ThinkingConfig, ProviderResponse, ProviderRequest } from '../types/provider.js';

/**
 * Direction for partial compaction.
 * - 'from'  — summarise messages at the tail (after pivotIndex), keep the head intact.
 *             Prompt-cache prefix for the kept (earlier) messages is preserved.
 * - 'up_to' — summarise the head prefix (before pivotIndex), keep later messages.
 *             The summary is placed before the kept recent messages.
 */
export type PartialCompactDirection = 'from' | 'up_to';
import { estimateContentBlockTokens, estimateMessageTokens, estimateTokens, ApiTokenAnchor } from '../utils/tokens.js';
import {
  AUTO_COMPACT_THRESHOLD,
  MAX_INPUT_TOKENS,
  TARGET_INPUT_TOKENS,
  API_COMPACT_THRESHOLD_PCT,
  API_COMPACT_TARGET_PCT,
  KEEP_RECENT_MESSAGES,
  MAX_CONSECUTIVE_COMPACT_FAILURES,
} from '../prompt/constants.js';

// ---------------------------------------------------------------------------
// AutoCompactState — tracks compaction across turns
// ---------------------------------------------------------------------------

/** Tracks auto-compact state across turns. */
export class AutoCompactState {
  /** Total compactions performed this session. */
  compactionCount = 0;
  /** Consecutive failures (reset on success). */
  consecutiveFailures = 0;
  /** Whether the circuit breaker is open (too many failures). */
  disabled = false;

  /** Record a successful compaction. */
  onSuccess(): void {
    this.compactionCount++;
    this.consecutiveFailures = 0;
  }

  /** Record a failed compaction; open circuit breaker if too many. */
  onFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
      this.disabled = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Token warning state
// ---------------------------------------------------------------------------

/** Token-usage state relative to the context window. */
export type TokenWarningState = 'ok' | 'warning' | 'critical';

const WARNING_PCT = 0.80;
const CRITICAL_PCT = 0.95;

/** Calculate token warning state given current input tokens and context window. */
export function calculateTokenWarningState(
  inputTokens: number,
  contextWindow: number,
): TokenWarningState {
  const pct = inputTokens / contextWindow;
  if (pct >= CRITICAL_PCT) return 'critical';
  if (pct >= WARNING_PCT) return 'warning';
  return 'ok';
}

// ---------------------------------------------------------------------------
// shouldAutoCompact
// ---------------------------------------------------------------------------

/** Return true when auto-compaction should fire. */
export function shouldAutoCompact(
  inputTokens: number,
  contextWindow: number,
  state: AutoCompactState,
): boolean {
  if (state.disabled) return false;
  const threshold = Math.floor(contextWindow * AUTO_COMPACT_THRESHOLD);
  return inputTokens >= threshold;
}

// ---------------------------------------------------------------------------
// Micro compact — replace old tool results with placeholders
// ---------------------------------------------------------------------------

/**
 * Number of most-recent tool cycles (user messages carrying tool_result
 * blocks) that microCompact never truncates. A fresh result must survive
 * long enough for the model to read it; only aged results are replaceable.
 */
const PROTECTED_RECENT_TOOL_CYCLES = 2;

const MAX_INPUT_PREVIEW_CHARS = 120;

/**
 * Build the truncation placeholder. States what was omitted (tool name,
 * input preview, size) and how to recover it, so the model can re-fetch
 * instead of acting on missing data.
 */
function buildTruncationPlaceholder(
  omittedChars: number,
  toolUse?: { name: string; input: unknown },
): string {
  if (!toolUse) {
    return `[tool result truncated to save context — ${omittedChars} chars omitted; recover recorded output from the session transcript; verify effects before repeating an action]`;
  }
  let inputPreview = '';
  try {
    inputPreview = JSON.stringify(toolUse.input) ?? '';
  } catch {
    inputPreview = '';
  }
  if (inputPreview.length > MAX_INPUT_PREVIEW_CHARS) {
    inputPreview = inputPreview.slice(0, MAX_INPUT_PREVIEW_CHARS) + '…';
  }
  return `[tool result truncated to save context: ${toolUse.name} ${inputPreview} — ${omittedChars} chars omitted; recover recorded output from the session transcript; verify effects before repeating an action]`;
}

/** Map tool_use_id → { name, input } for all assistant tool_use blocks. */
function buildToolUseIndex(
  messages: Message[],
): Map<string, { name: string; input: unknown }> {
  const index = new Map<string, { name: string; input: unknown }>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_use') {
        index.set(block.id, { name: block.name, input: block.input });
      }
    }
  }
  return index;
}

/**
 * Index of the first message inside the protected recent range.
 * Walks back from the tail counting tool cycles; the assistant message
 * that issued the oldest protected cycle's tool_use is included so a
 * cycle is never half-protected.
 *
 * Returns 0 (protect everything) when fewer than
 * PROTECTED_RECENT_TOOL_CYCLES cycles exist — all results are fresh.
 */
function protectedRecentIndex(messages: Message[]): number {
  let cycles = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && hasToolResultBlocks(msg)) {
      cycles++;
      if (cycles === PROTECTED_RECENT_TOOL_CYCLES) {
        return i > 0 && messages[i - 1].role === 'assistant' ? i - 1 : i;
      }
    }
  }
  return 0;
}

/**
 * Estimate the character size of a ToolResultBlock's content.
 * Handles both string content and array-typed content (ContentBlock[]).
 */
function toolResultContentSize(content: ToolResultBlock['content']): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let size = 0;
  for (const block of content) {
    if (block.type === 'text') {
      size += block.text.length;
    } else if (block.type === 'tool_result') {
      // Nested tool_result — recurse
      size += toolResultContentSize((block as ToolResultBlock).content);
    } else if (block.type === 'image') {
      // Keep the text-character budget comparable to visual token cost,
      // rather than charging encoded image bytes as conversation text.
      size += Math.ceil(estimateContentBlockTokens(block) / 0.3);
    } else if (block.type === 'document') {
      size += block.source.data.length;
    }
  }
  return size;
}

/**
 * Micro-compact: when cumulative tool-result content exceeds `budget`
 * characters, walk from oldest to newest and replace individual
 * tool_result content with a placeholder until under budget.
 *
 * The most recent PROTECTED_RECENT_TOOL_CYCLES tool cycles are never
 * touched — a fresh result the model has not acted on yet must survive.
 * If shedding old results is not enough, the residual overage is left
 * for the heavier compaction tiers.
 *
 * Handles both string and array-typed tool_result content.
 */
export function microCompact(
  messages: Message[],
  budget: number,
): { messages: Message[]; truncatedCount: number } {
  const total = totalToolResultChars(messages);
  if (total <= budget) {
    return { messages, truncatedCount: 0 };
  }

  const protectFrom = protectedRecentIndex(messages);
  const toolUseIndex = buildToolUseIndex(messages);

  let toShed = total - budget;
  let truncatedCount = 0;

  const result = messages.map((msg, idx) => {
    if (
      idx >= protectFrom ||
      msg.role !== 'user' ||
      typeof msg.content === 'string' ||
      toShed <= 0
    ) {
      return msg;
    }
    const newContent = (msg.content as ContentBlock[]).map((block) => {
      if (toShed <= 0) return block;
      if (block.type !== 'tool_result') return block;
      const trBlock = block as ToolResultBlock;
      const size = toolResultContentSize(trBlock.content);
      if (size === 0 || (typeof trBlock.content === 'string' &&
          trBlock.content.startsWith('[tool result truncated to save context'))) return block;
      const content = buildTruncationPlaceholder(size, toolUseIndex.get(trBlock.tool_use_id));
      const saved = size - content.length;
      if (saved <= 0) return block;

      truncatedCount++;
      toShed = Math.max(0, toShed - saved);
      return { ...trBlock, content } as ToolResultBlock;
    });
    return { ...msg, content: newContent };
  });

  return { messages: result, truncatedCount };
}

/** Total character count of all tool-result content blocks. */
function totalToolResultChars(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        total += toolResultContentSize((block as ToolResultBlock).content);
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// API compact — strip old messages when over MAX_INPUT_TOKENS
// ---------------------------------------------------------------------------

/**
 * API-level compact: when estimated input tokens exceed MAX_INPUT_TOKENS,
 * strip the oldest messages (keeping KEEP_RECENT_MESSAGES) to bring
 * the total under TARGET_INPUT_TOKENS.
 *
 * This is a local operation — no LLM call needed.
 *
 * Retained results must include their preceding call message; the cut can
 * therefore retain more content than the target budget.
 */
export function apiCompact(
  messages: Message[],
  anchor?: ApiTokenAnchor,
  contextWindow?: number,
): Message[] | null {
  // Window-relative thresholds when the window is known; the absolute
  // constants remain the fallback for callers that don't pass one.
  const maxInput = contextWindow
    ? Math.floor(contextWindow * API_COMPACT_THRESHOLD_PCT)
    : MAX_INPUT_TOKENS;
  const targetInput = contextWindow
    ? Math.floor(contextWindow * API_COMPACT_TARGET_PCT)
    : TARGET_INPUT_TOKENS;

  const totalTokens = anchor
    ? anchor.estimateWithAnchor(messages)
    : estimateMessageTokens(messages);
  if (totalTokens < maxInput) {
    return null;
  }

  if (messages.length <= KEEP_RECENT_MESSAGES + 1) {
    return null;
  }

  // Find the split point: walk from the end, keeping messages until
  // we exceed the target remaining budget.
  let accumulated = 0;
  let keepFrom = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const est = estimateMessageTokens([messages[i]]);
    if (accumulated + est > targetInput) {
      keepFrom = i + 1;
      break;
    }
    accumulated += est;
    keepFrom = i;
  }

  // Always keep at least KEEP_RECENT_MESSAGES
  keepFrom = Math.min(keepFrom, messages.length - KEEP_RECENT_MESSAGES);
  if (keepFrom <= 0) return null;

  keepFrom = adjustForToolPairing(messages, keepFrom);

  if (keepFrom <= 0) return null;

  // Preserve the first user message (the original task statement) so this
  // emergency trim never severs the conversation from its goal.
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  const kept = messages.slice(keepFrom);
  if (firstUserIdx !== -1 && firstUserIdx < keepFrom) {
    return [messages[firstUserIdx], ...kept];
  }
  return kept;
}

/** Preserve the call message required by a result at the retained boundary. */
function adjustForToolPairing(messages: Message[], keepFrom: number): number {
  if (keepFrom <= 0 || keepFrom >= messages.length) return keepFrom;
  const owners = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return;
    for (const block of message.content) if (block.type === 'tool_use') owners.set(block.id, index);
  });
  let boundary = keepFrom;
  for (let index = messages.length - 1; index >= boundary; index--) {
    const message = messages[index];
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_result') boundary = Math.min(boundary, owners.get(block.tool_use_id) ?? boundary);
    }
  }
  return boundary;
}

/** Check if a message contains tool_result content blocks. */
function hasToolResultBlocks(msg: Message): boolean {
  if (typeof msg.content === 'string') return false;
  return (msg.content as ContentBlock[]).some((b) => b.type === 'tool_result');
}

// ---------------------------------------------------------------------------
// Full compact — LLM-based summarisation
// ---------------------------------------------------------------------------

/** Build the default handover instructions for public callers. */
export function getCompactPrompt(customInstructions?: string): string {
  return buildSummaryPrompt({ instructions: customInstructions });
}

/** Accept legacy response envelopes without interpreting tags inside the handover. */
export function formatCompactSummary(raw: string): string {
  let text = raw.trim();
  const leadingAnalysis = /^<analysis>((?:(?!<\/?analysis>)[\s\S])*)<\/analysis>(?:\r?\n|$)/.exec(text);
  if (leadingAnalysis) text = text.slice(leadingAnalysis[0].length).trim();

  const envelope = /^<summary>((?:(?!<\/?summary>)[\s\S])*)<\/summary>$/.exec(text);
  if (envelope) text = `Summary:\n${envelope[1].trim()}`;

  return text;
}

/**
 * Build a transcript of messages for the compact summariser.
 */
function buildTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? 'Human' : 'Assistant';
    if (typeof msg.content === 'string') {
      if (msg.content) {
        parts.push(`${roleLabel}: ${msg.content}`);
      }
    } else {
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            parts.push(`${roleLabel}: ${block.text}`);
            break;
          case 'tool_use':
            parts.push(`[Tool Call: ${block.name} (id=${block.id})]\nInput: ${JSON.stringify(block.input)}`);
            break;
          case 'tool_result': {
            const trBlock = block as ToolResultBlock;
            let content: string;
            if (typeof trBlock.content === 'string') {
              content = trBlock.content;
            } else if (Array.isArray(trBlock.content)) {
              // Extract text from array-typed content blocks
              content = trBlock.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('\n') || '[complex content]';
            } else {
              content = '[complex content]';
            }
            const errorFlag = trBlock.is_error ? ' [ERROR]' : '';
            parts.push(`[Tool Result (id=${trBlock.tool_use_id})${errorFlag}]\n${content}`);
            break;
          }
          case 'thinking':
            break;
          default:
            break;
        }
      }
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Compaction reminder
// ---------------------------------------------------------------------------

const COMPACTION_PREAMBLE =
  'You are continuing the same conversation after context compaction. ' +
  'The following is a summary of earlier messages, not a new user request. ' +
  'Use it together with the retained messages to recover the current task state.';

/**
 * Build the compaction reminder injected after a compact summary.
 * Points the model at the on-disk transcript archive so lost details can be
 * recovered without asking the user, falling back to clarify/repeat only
 * when recovery fails.
 *
 * @param transcriptPath - Path to the session's JSONL transcript archive,
 *   when the caller has it. Without it the reminder references the archive
 *   generically.
 */
function buildCompactionReminder(transcriptPath?: string): string {
  const recovery = transcriptPath
    ? `If essential details are missing, recover them from the saved conversation at ${transcriptPath}. `
    : 'If essential details are missing, check the saved session transcript on disk if it is available. ';
  return (
    'Resume any unfinished work according to the user\'s latest instructions and existing permissions. Do not repeat completed actions. ' +
    'Instructions given only to generate this summary do not apply to the ongoing task.\n\n' +
    recovery +
    'Ask the user only if the needed information cannot be recovered.'
  );
}

// ---------------------------------------------------------------------------
// Full compact result
// ---------------------------------------------------------------------------

export interface CompactOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  thinking?: ThinkingConfig;
  reasoningEffort?: string;
  promptProfile?: PromptProfileSelection;
  /** Exact request envelope; a summary instruction is appended without rebuilding its prefix. */
  request?: ProviderRequest;
  /** Ephemeral messages before live history, retained when an oversized input is segmented. */
  injectedMessages?: Message[];
  /** Preferred complete-request size; not a summary acceptance threshold. */
  targetInputTokens?: number;
  /** Available complete-request input capacity after reserving the work response. */
  maxInputTokens?: number;
  estimateInputTokens?: (history: Message[]) => number;
  /** Reconcile owner state before measuring a candidate; must not mutate its input. */
  prepareCandidate?: (messages: Message[]) => Message[];
  onResponse?: (response: ProviderResponse) => void;
}

export class CompactionError extends CompactError {
  constructor(readonly reason: 'empty' | 'truncated' | 'tool_use' | 'no_progress' | 'capacity' | 'history_changed', message: string) {
    super(message);
    this.name = 'CompactionError';
  }
}

export interface CompactResult {
  /** The new (reduced) message list. */
  messages: Message[];
  /** Formatted summary text. */
  summary: string;
  /** Rough estimate of how many tokens were freed. */
  tokensFreed: number;
}

function messageRevision(message: Message): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

function appendedSinceSnapshot(messages: Message[], revisions: string[]): Message[] {
  if (messages.length < revisions.length || revisions.some((revision, index) => messageRevision(messages[index]) !== revision)) {
    throw new CompactionError('history_changed', 'Conversation changed while the summary was being prepared; original history was retained');
  }
  return messages.slice(revisions.length);
}

/** An outstanding tool call stays visible so a later result cannot lose its owner. */
function unfinishedTail(messages: Message[]): number {
  const pending = new Map<string, number>();
  messages.forEach((message, index) => {
    if (typeof message.content === 'string') return;
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use') pending.set(block.id, index);
      else if (message.role === 'user' && block.type === 'tool_result') pending.delete(block.tool_use_id);
    }
  });
  let boundary = messages.length;
  for (const index of pending.values()) boundary = Math.min(boundary, index);
  return boundary;
}

function waitForSummary(operation: Promise<ProviderResponse>, signal?: AbortSignal): Promise<ProviderResponse> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Compaction cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function summaryText(response: ProviderResponse, maxTokens: number, emptyError: string): string {
  if (response.stopReason === 'max_tokens' || (response.usage?.output_tokens ?? 0) > maxTokens) {
    throw new CompactionError('truncated', 'Compaction summary exceeded its output budget; original history was retained');
  }
  if (response.stopReason === 'tool_use' || response.content.some((block) => block.type === 'tool_use')) {
    throw new CompactionError('tool_use', 'Summary response requested a tool; original history was retained');
  }
  const text = formatCompactSummary(response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join(''));
  if (!text) throw new CompactionError('empty', emptyError);
  const reportedOutput = response.usage?.output_tokens;
  if (!(typeof reportedOutput === 'number' && Number.isFinite(reportedOutput) && reportedOutput > 0) && estimateTokens(text) > maxTokens) {
    throw new CompactionError('truncated', 'Compaction summary exceeded its estimated output budget; original history was retained');
  }
  return text;
}

function summaryBudget(options?: CompactOptions): number {
  const limit = options?.maxTokens ?? 20_000;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Summary output budget must be a positive integer');
  return limit;
}

/**
 * Full compact: summarise the head of the conversation using the LLM,
 * keep the most recent KEEP_RECENT_MESSAGES verbatim.
 *
 * This is the heaviest compaction tier — it makes an API call.
 *
 * @param messages - Full current message history.
 * @param provider - LLM provider to use for the summary call.
 * @param model - Model identifier.
 * @param _systemPrompt - System prompt (unused in this tier; kept for signature parity).
 * @param attachments - Optional messages to re-inject after the summary. The caller
 *   (query-loop) decides which attachments to pass — e.g. recently read files, plan
 *   file contents, or skill attachments. This function simply appends them after the
 *   summary message so the model has full context on the next turn.
 * @param customInstructions - Optional extra compact instructions (forwarded to the prompt).
 * @param transcriptPath - Optional path to the on-disk transcript archive,
 *   referenced in the compaction reminder for detail recovery.
 */
export async function fullCompact(
  messages: Message[],
  provider: LlmProvider,
  model: string,
  _systemPrompt: string,
  attachments: Message[] = [],
  customInstructions?: string,
  transcriptPath?: string,
  options?: CompactOptions,
): Promise<CompactResult> {
  options?.signal?.throwIfAborted();
  const total = messages.length;

  const targeted = options?.targetInputTokens !== undefined && options.estimateInputTokens !== undefined;
  const prepareCandidate = (candidate: Message[]) => options?.prepareCandidate?.(candidate) ?? candidate;
  if (total < 2 || (!targeted && total <= KEEP_RECENT_MESSAGES + 1)) {
    return { messages: [...messages], summary: '', tokensFreed: 0 };
  }

  const snapshot = messages.slice();
  const revisions = snapshot.map(messageRevision);
  let latestRequest: Message | undefined;
  for (let index = snapshot.length - 1; index >= 0; index--) {
    const message = snapshot[index];
    if (message.role === 'user' && !message.isMeta &&
        (typeof message.content === 'string' || !message.content.some(block => block.type === 'tool_result'))) {
      latestRequest = message;
      break;
    }
  }
  const notice = (text: string, count: number, tokens: number): Message => ({ role: 'user', content:
    `${COMPACTION_PREAMBLE}\n\nSummary of ${count} earlier messages (approximately ${tokens} tokens before compaction):\n\n` +
    `${text}\n\n${buildCompactionReminder(transcriptPath)}`,
  });
  let maxTokens = summaryBudget(options);
  let keepFrom = Math.max(0, total - KEEP_RECENT_MESSAGES);
  if (targeted) {
    const target = options!.targetInputTokens!;
    const estimate = options!.estimateInputTokens!;
    const fixed = estimate(prepareCandidate([notice('', total, estimateMessageTokens(snapshot)), ...attachments,
      ...(latestRequest ? [latestRequest] : []),
    ]));
    const capacity = options!.maxInputTokens ?? Infinity;
    if (fixed >= capacity) {
      throw new CompactionError('capacity', 'System instructions, tools and required task state fill the input capacity; original history was retained');
    }
    const remaining = capacity - fixed;
    const preferredSpace = target > fixed ? target - fixed : Math.min(remaining, maxTokens * 3);
    const space = Math.max(0, Math.min(preferredSpace, remaining));
    maxTokens = Math.min(maxTokens, Math.max(1, Math.floor(Math.min(remaining / 2, Math.max(1024, space / 3)))));
    const tailBudget = space / 3;
    let tailTokens = 0;
    keepFrom = total;
    for (let index = total - 1; index >= 1; index--) {
      const size = estimateMessageTokens([snapshot[index]]);
      if (tailTokens + size > tailBudget) break;
      tailTokens += size;
      keepFrom = index;
    }
  }
  // Calls and their results must stay on the same side of the boundary.
  const splitAt = Math.min(adjustForToolPairing(snapshot, keepFrom), unfinishedTail(snapshot));
  if (splitAt === 0) return { messages: [...messages], summary: '', tokensFreed: 0 };
  const head = snapshot.slice(0, splitAt);
  const tail = snapshot.slice(splitAt);
  const retainedRequest = latestRequest && head.includes(latestRequest) ? [latestRequest] : [];

  const originalTokenEstimate = estimateMessageTokens(head);
  const compactPrompt = buildSummaryPrompt({
    instructions: customInstructions,
    maxTokens,
    modelGuidance: resolvePromptProfile(model, options?.promptProfile).summaryGuidance,
  });
  const envelope = options?.request;
  const instruction = envelope
    ? `${compactPrompt}\n\nThe last ${tail.length} conversation messages will also remain verbatim. Summarize the earlier work; use the recent messages to avoid stale conclusions. No tools will be executed for this handover.`
    : `${compactPrompt}\n\n<conversation_to_summarize original_messages="${head.length}" estimated_tokens="${originalTokenEstimate}">\n${buildTranscript(head)}\n</conversation_to_summarize>`;
  const request: ProviderRequest = envelope ? {
    ...envelope,
    messages: [...envelope.messages, { role: 'user', content: instruction }],
    maxTokens,
    providerOptions: { ...envelope.providerOptions, signal: options?.signal, skipCacheWrite: true },
    stream: false,
  } : {
    model,
    messages: [{ role: 'user', content: instruction }],
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    tools: [],
    maxTokens,
    thinking: options?.thinking,
    providerOptions: { signal: options?.signal, ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}) },
    stream: false,
  };
  if (request.thinking?.type === 'adaptive') {
    // The handover text target must not also starve adaptive reasoning.
    request.maxTokens = summaryBudget(options);
  }
  if (request.thinking?.type === 'enabled') {
    // Keep the work reservation when the provider clamps thinking to that limit.
    request.maxTokens = Math.min(envelope?.maxTokens ?? summaryBudget(options),
      maxTokens + request.thinking.budgetTokens);
  }
  let summaryCalls = 0;
  let lastSummaryRequest = request;
  const summarize = async (sent: ProviderRequest, outputCeiling = envelope?.maxTokens ?? sent.maxTokens): Promise<string> => {
    options?.signal?.throwIfAborted();
    if (++summaryCalls > 16) {
      throw new CompactionError('capacity', 'Summary recovery reached its request limit; original history was retained');
    }
    lastSummaryRequest = sent;
    const response = await waitForSummary(provider.createMessage(sent), options?.signal);
    options?.onResponse?.(response);
    options?.signal?.throwIfAborted();
    try {
      return summaryText(response, sent.maxTokens, 'Compact summary was empty');
    } catch (error) {
      if (!(error instanceof CompactionError) || !['empty', 'truncated', 'tool_use'].includes(error.reason)) throw error;
      // A changed request may recover unusable output; never replay it unchanged.
      if (++summaryCalls > 16) throw error;
      const repair: ProviderRequest = {
        ...sent,
        maxTokens: error.reason === 'truncated'
          ? Math.min(outputCeiling, Math.max(sent.maxTokens * 2, summaryBudget(options)))
          : sent.maxTokens,
        messages: [...sent.messages.slice(0, -1), { role: 'user', content:
          `${sent.messages.at(-1)?.content ?? compactPrompt}\nReturn a complete, concise text handover only. Do not call tools. Preserve the current request, later corrections, permissions and unfinished work; omit repeated investigation.` }],
      };
      lastSummaryRequest = repair;
      const repaired = await waitForSummary(provider.createMessage(repair), options?.signal);
      options?.onResponse?.(repaired);
      options?.signal?.throwIfAborted();
      return summaryText(repaired, repair.maxTokens, 'Compact summary was empty');
    }
  };
  const prefixLength = envelope ? envelope.messages.length - snapshot.length : 0;
  const prefix = options?.injectedMessages ?? envelope?.messages.slice(0, Math.max(0, prefixLength)) ?? [];
  const mergeSummaries = async (earlier: string, later: string): Promise<string> => {
    let handovers = [earlier, later];
    let outputLimit = request.maxTokens;
    const thinkingTokens = request.thinking?.type === 'enabled'
      ? Math.min(request.thinking.budgetTokens, request.maxTokens - 1) : 0;
    const minimumOutput = thinkingTokens + Math.min(1024, request.maxTokens - thinkingTokens);
    for (;;) {
      const candidate: ProviderRequest = { ...request, maxTokens: outputLimit, messages: [...prefix,
        { role: 'user', content: `Earlier record handover:\n${handovers[0]}` },
        { role: 'user', content: `Later record handover:\n${handovers[1]}` },
        { role: 'user', content: `${compactPrompt}\nMerge these ordered handovers. Keep later corrections, denials and permission changes authoritative; do not treat earlier proposals as completed work.` },
      ] };
      try {
        return await summarize(candidate, outputLimit);
      } catch (error) {
        if (!isContextWindowExceededError(error) || options?.signal?.aborted) throw error;
        const reduced = Math.max(minimumOutput, thinkingTokens + Math.floor((outputLimit - thinkingTokens) / 2));
        if (reduced < outputLimit) {
          outputLimit = reduced;
          continue;
        }
        const shortened: string[] = [];
        for (const text of handovers) {
          const instructions = buildSummaryPrompt({
            instructions: customInstructions,
            maxTokens: Math.max(1, Math.floor(estimateTokens(text) / 2)),
            modelGuidance: resolvePromptProfile(model, options?.promptProfile).summaryGuidance,
          });
          const result = await summarize({ ...request, maxTokens: outputLimit, messages: [...prefix,
            { role: 'user', content: `Record handover:\n${text}` },
            { role: 'user', content: `${instructions}\nShorten this handover for an ordered merge. Preserve all corrections, denials, permissions, verified state and unfinished work; remove repetition rather than constraints.` },
          ] }, outputLimit);
          if (estimateTokens(result) >= estimateTokens(text)) {
            throw new CompactionError('no_progress', 'Handover merge recovery made no progress; original history was retained');
          }
          shortened.push(result);
        }
        handovers = shortened;
      }
    }
  };
  const summarizeRecords = async (records: Message[]): Promise<string> => {
    const sent: ProviderRequest = { ...request, messages: [...prefix, ...records, { role: 'user', content:
      `${compactPrompt}\nThese are ordered records from the work being replaced. Newer verbatim records remain unchanged. Preserve later corrections over earlier proposals.` }] };
    try {
      return await summarize(sent);
    } catch (error) {
      if (!isContextWindowExceededError(error) || options?.signal?.aborted) throw error;
      const pending = new Set<string>();
      let boundary = 0;
      for (let index = 0; index < records.length - 1; index++) {
        const message = records[index];
        if (typeof message.content !== 'string') {
          for (const block of message.content) {
            if (message.role === 'assistant' && block.type === 'tool_use') pending.add(block.id);
            if (message.role === 'user' && block.type === 'tool_result') pending.delete(block.tool_use_id);
          }
        }
        if (pending.size === 0 && (boundary === 0 || Math.abs(index + 1 - records.length / 2) < Math.abs(boundary - records.length / 2))) {
          boundary = index + 1;
        }
      }
      if (boundary <= 0 || boundary >= records.length) {
        throw new CompactionError('capacity', 'A required conversation record cannot fit the provider window for summarization; original history was retained');
      }
      const earlier = await summarizeRecords(records.slice(0, boundary));
      const later = await summarizeRecords(records.slice(boundary));
      return mergeSummaries(earlier, later);
    }
  };
  let formattedSummary: string;
  try {
    formattedSummary = await summarize(request);
  } catch (error) {
    if (!envelope || prefixLength < 0 || options?.signal?.aborted || !isContextWindowExceededError(error)) throw error;
    getLogger('Compact').warn('Summary input exceeded the provider window; summarizing ordered records without dropping evidence', {
      headMessages: head.length, retainedMessages: tail.length,
    });
    formattedSummary = await summarizeRecords(head);
  }

  const candidate = (): Message[] => prepareCandidate([notice(formattedSummary, head.length, originalTokenEstimate),
    ...attachments, ...retainedRequest, ...tail, ...appendedSinceSnapshot(messages, revisions)]);
  let newMessages = candidate();
  const shrinks = () => estimateMessageTokens(newMessages) < estimateMessageTokens(messages) &&
    (!targeted || options!.estimateInputTokens!(newMessages) < options!.estimateInputTokens!(messages));
  if (targeted && !shrinks()) {
    formattedSummary = await summarize({ ...lastSummaryRequest, messages: [...lastSummaryRequest.messages.slice(0, -1),
      { role: 'user', content: `${lastSummaryRequest.messages.at(-1)?.content ?? compactPrompt}\nThe handover must reduce the record size. Keep only decisive constraints, verified outcomes, unfinished work and recovery references. Do not reproduce logs, file bodies or repeated attempts.` },
    ] }, lastSummaryRequest.maxTokens);
    newMessages = candidate();
  }
  const tokensFreed = Math.max(0, estimateMessageTokens(messages) - estimateMessageTokens(newMessages));
  if (targeted && !shrinks()) {
    throw new CompactionError('no_progress', 'Compaction made no progress after a concise handover retry; original history was retained');
  }
  if (options?.maxInputTokens !== undefined && options.estimateInputTokens &&
      options.estimateInputTokens(newMessages) >= options.maxInputTokens) {
    throw new CompactionError('capacity', 'Compacted history and required task state exceed the input capacity; original history was retained');
  }

  return { messages: newMessages, summary: formattedSummary, tokensFreed };
}

// ---------------------------------------------------------------------------
// Partial compact
// ---------------------------------------------------------------------------

/**
 * Options for partial compaction.
 */
export interface PartialCompactOptions extends CompactOptions {
  /**
   * Index into `messages` that acts as the pivot.
   * - direction 'from'  : summarise messages[pivotIndex..], keep messages[0..pivotIndex-1].
   * - direction 'up_to' : summarise messages[0..pivotIndex-1], keep messages[pivotIndex..].
   */
  pivotIndex: number;
  /** Which part of the conversation to summarise (default: 'from'). */
  direction?: PartialCompactDirection;
  /** LLM provider for the summary call. */
  provider: LlmProvider;
  /** Model identifier. */
  model: string;
  /** Optional user-supplied context (appended to the compact prompt). */
  userFeedback?: string;
  /**
   * Optional messages to re-inject after the summary.
   * The caller decides what to include (recent files, plan, skills, etc.).
   */
  attachments?: Message[];
  /** Optional transcript archive path referenced in the compaction reminder. */
  transcriptPath?: string;
}

/**
 * Partial compact: summarise only a slice of the conversation (either the
 * recent tail or the older head), leaving the other half intact.
 *
 * - 'from'  direction: keep messages[0..pivotIndex-1] (older, cache-hot prefix),
 *   summarise messages[pivotIndex..] (the recent tail).
 * - 'up_to' direction: summarise messages[0..pivotIndex-1] (older head),
 *   keep messages[pivotIndex..] (the recent messages the user wants to preserve).
 *
 * The returned `CompactResult.messages` is the fully rebuilt array ready to
 * replace the current history:
 *   [summary_message, ...attachments, ...kept_messages]
 *
 * @example
 * // Summarise only the recent tail (keep early context hot):
 * const result = await partialCompact(messages, {
 *   pivotIndex: 40,
 *   direction: 'from',
 *   provider,
 *   model,
 * });
 *
 * // Summarise the old prefix (keep the last few turns verbatim):
 * const result = await partialCompact(messages, {
 *   pivotIndex: messages.length - 5,
 *   direction: 'up_to',
 *   provider,
 *   model,
 * });
 */
export async function partialCompact(
  messages: Message[],
  options: PartialCompactOptions,
): Promise<CompactResult> {
  options.signal?.throwIfAborted();
  const {
    pivotIndex,
    direction = 'from',
    provider,
    model,
    userFeedback,
    attachments = [],
    transcriptPath,
  } = options;

  if (!Number.isInteger(pivotIndex) || pivotIndex < 0 || pivotIndex > messages.length) {
    throw new RangeError('Compaction boundary must be an integer within the conversation');
  }
  const snapshot = messages.slice();
  const revisions = snapshot.map(messageRevision);
  const maxTokens = summaryBudget(options);
  const tailStart = unfinishedTail(snapshot);
  const boundary = adjustForToolPairing(snapshot, pivotIndex);
  const summaryEnd = direction === 'up_to' ? Math.min(boundary, tailStart) : tailStart;

  const messagesToSummarize =
    direction === 'up_to'
      ? snapshot.slice(0, summaryEnd)
      : snapshot.slice(boundary, summaryEnd);

  const messagesToKeep =
    direction === 'up_to'
      ? snapshot.slice(summaryEnd)
      : snapshot.slice(0, boundary);

  if (messagesToSummarize.length === 0) {
    throw new Error(`Selected conversation slice contains no messages (${direction}, boundary ${boundary}).`);
  }

  const transcript = buildTranscript(messagesToSummarize);

  const customInstructions = userFeedback ? `User context: ${userFeedback}` : undefined;
  const compactPrompt = buildSummaryPrompt({
    scope: direction === 'up_to' ? 'prefix' : 'suffix',
    instructions: customInstructions,
    maxTokens,
    modelGuidance: resolvePromptProfile(model, options.promptProfile).summaryGuidance,
  });

  const userContent =
    `${compactPrompt}\n\n` +
    `<conversation_to_summarize original_messages="${messagesToSummarize.length}">\n` +
    `${transcript}\n` +
    `</conversation_to_summarize>`;

  const response = await waitForSummary(provider.createMessage({
    model,
    messages: [{ role: 'user', content: userContent }],
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    tools: [],
    maxTokens,
    thinking: options.thinking,
    providerOptions: { signal: options.signal, ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}) },
    stream: false,
  }), options.signal);

  options.signal?.throwIfAborted();
  const formattedSummary = summaryText(response, maxTokens, 'Partial compact summary was empty');

  // Include compaction reminder in the partial summary notice as well.
  const summaryMessage: Message = {
    role: 'user',
    content:
      `${COMPACTION_PREAMBLE}\n\nSummary of ${messagesToSummarize.length} earlier messages:\n\n` +
      `${formattedSummary}\n\n${buildCompactionReminder(transcriptPath)}`,
  };

  const arrivals = appendedSinceSnapshot(messages, revisions);
  const candidate: Message[] =
    direction === 'up_to'
      ? [summaryMessage, ...attachments, ...messagesToKeep, ...arrivals]
      : [...messagesToKeep, summaryMessage, ...attachments, ...snapshot.slice(summaryEnd), ...arrivals];
  const newMessages = options.prepareCandidate?.(candidate) ?? candidate;

  const newTokenEstimate = estimateMessageTokens(newMessages);
  const tokensFreed = Math.max(0, estimateMessageTokens(messages) - newTokenEstimate);

  return { messages: newMessages, summary: formattedSummary, tokensFreed };
}

/**
 * Auto-compact if needed: checks thresholds and runs full compact.
 * Returns null if no compaction was needed/possible.
 *
 * @param attachments - Optional post-compact reinject messages (passed through to fullCompact).
 * @param transcriptPath - Optional transcript archive path (passed through to fullCompact).
 */
export async function autoCompactIfNeeded(
  messages: Message[],
  inputTokens: number,
  contextWindow: number,
  model: string,
  provider: LlmProvider,
  systemPrompt: string,
  state: AutoCompactState,
  attachments: Message[] = [],
  transcriptPath?: string,
  options?: CompactOptions,
): Promise<CompactResult | null> {
  if (!shouldAutoCompact(inputTokens, contextWindow, state)) {
    return null;
  }

  try {
    const result = await fullCompact(
      messages,
      provider,
      model,
      systemPrompt,
      attachments,
      undefined,
      transcriptPath,
      options,
    );
    if (!result.summary) return null;
    state.onSuccess();
    return result;
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    state.onFailure();
    getLogger('Compact').warn('automatic compaction failed; retaining current history', {
      error: String(error), failures: state.consecutiveFailures, disabled: state.disabled,
    });
    return null;
  }
}
