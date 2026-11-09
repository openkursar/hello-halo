/**
 * @module llm/anthropic
 * Anthropic Messages API provider implementation.
 * POST to https://api.anthropic.com/v1/messages with native SSE streaming.
 * @license MIT
 */

import type {
  ContentBlock,
  LlmProvider,
  ProviderCapabilities,
  ProviderModelInfo,
  ProviderRequest,
  ProviderResponse,
  ProviderStatus,
  StopReason,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  UsageInfo,
} from '../types/provider.js';
import { parseSSEStream } from './stream-parser.js';
import {
  DEFAULT_RETRY,
  delayForAttempt,
  describeFetchError,
  httpRetryDelay,
  sleep,
} from '../utils/retry.js';
import { apiErrorMessage, isAbortError, ModelFallbackError, ProviderError, withRetriesExhausted } from '../utils/errors.js';
import {
  build529Strategy,
  DEFAULT_RETRY_STRATEGY,
  type RetryStrategy,
} from './retry-strategy.js';
import { buildBetas } from './anthropic-betas.js';
import { addCacheBreakpoints, addSystemPromptCacheBreakpoint } from './cache-breakpoints.js';
import {
  generateRequestId,
  type RequestIdentity,
} from './request-identity.js';
import { getLogger } from '../utils/logger.js';
import { assertImageBodyBudget, assertImageRequestBudget } from './image-request-budget.js';

const log = getLogger('AnthropicProvider');

// ---------------------------------------------------------------------------
// Non-streaming fallback constants
// ---------------------------------------------------------------------------

/**
 * Number of consecutive mid-stream failures that trigger automatic degradation
 * to non-streaming mode within a single createMessageStream() call. A failure
 * to connect at all is not a streaming failure and is retried with backoff.
 */
const MAX_STREAMING_FAILURES = 1;

/**
 * Maximum max_tokens value for non-streaming fallback requests.
 * Preserve a bounded response allocation when a streaming attempt falls back.
 */
const MAX_NON_STREAMING_TOKENS = 64_000;

/** `max_tokens` sent when the request does not specify one. */
const DEFAULT_MAX_TOKENS = 16_384;

function isThinkingRequested(request: ProviderRequest): boolean {
  return request.thinking !== undefined && request.thinking.type !== 'disabled';
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  /** Anthropic API key */
  apiKey: string;
  /** Base URL override (defaults to https://api.anthropic.com) */
  baseUrl?: string;
  /** Anthropic API version header (defaults to 2023-06-01) */
  apiVersion?: string;
  /** Beta feature headers to include */
  betas?: string[];
  /** Additional headers to send on every request */
  headers?: Record<string, string>;
  /** Default model to use when none is specified */
  defaultModel?: string;
  /**
   * Optional request identity injected by the host application.
   * When provided, custom headers, system-prompt prefix, and body metadata
   * are included in every API request.
   */
  requestIdentity?: RequestIdentity;
}

export type { RequestIdentity } from './request-identity.js';

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly betas: string[];
  private readonly extraHeaders: Record<string, string>;
  private readonly defaultModel: string | undefined;
  private readonly requestIdentity: RequestIdentity | undefined;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiVersion = config.apiVersion ?? '2023-06-01';
    this.betas = config.betas ?? [];
    this.extraHeaders = config.headers ?? {};
    this.defaultModel = config.defaultModel;
    this.requestIdentity = config.requestIdentity;
  }

  private resolveModel(request: ProviderRequest): string {
    const model = request.model || this.defaultModel;
    if (!model) {
      throw new Error('No model specified: set ProviderRequest.model or AnthropicProviderConfig.defaultModel.');
    }
    return model;
  }

  // -----------------------------------------------------------------------
  // LlmProvider interface
  // -----------------------------------------------------------------------

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      thinking: true,
      imageInput: true,
      pdfInput: true,
      audioInput: false,
      videoInput: false,
      caching: true,
      systemPromptStyle: 'top_level',
    };
  }

  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    // Collect streaming events into a complete response
    const gen = this.createMessageStream({ ...request, stream: true });

    let id = 'unknown';
    let model = this.resolveModel(request);
    const contentBlocks: ContentBlock[] = [];
    const textParts: Map<number, string> = new Map();
    const thinkingParts: Map<number, { thinking: string; signature: string }> = new Map();
    const toolBuffers: Map<number, { id: string; name: string; jsonBuf: string }> = new Map();
    let stopReason: StopReason = 'end_turn';
    let usage: UsageInfo = { input_tokens: 0, output_tokens: 0 };

    for await (const event of gen) {
      switch (event.type) {
        case 'message_start':
          id = event.id;
          model = event.model;
          usage = event.usage;
          break;

        case 'content_block_start': {
          const cb = event.content_block;
          if (cb.type === 'text') {
            // Visible text is assembled from delta events only.
            textParts.set(event.index, '');
          } else if (cb.type === 'thinking') {
            thinkingParts.set(event.index, {
              thinking: '',
              signature: '',
            });
          } else if (cb.type === 'tool_use') {
            const tu = cb as ToolUseBlock;
            toolBuffers.set(event.index, { id: tu.id, name: tu.name, jsonBuf: '' });
          } else if ((cb as { type: string }).type === 'server_tool_use') {
            // Server-side tools (web search, code exec) — accumulate like tool_use
            const stu = cb as unknown as { type: string; id: string; name: string };
            toolBuffers.set(event.index, { id: stu.id, name: stu.name, jsonBuf: '' });
          } else {
            contentBlocks.push(cb);
          }
          break;
        }

        case 'text_delta':
          textParts.set(event.index, (textParts.get(event.index) ?? '') + event.text);
          break;

        case 'thinking_delta': {
          const existing = thinkingParts.get(event.index) ?? { thinking: '', signature: '' };
          thinkingParts.set(event.index, {
            thinking: existing.thinking + event.thinking,
            signature: existing.signature,
          });
          break;
        }

        case 'signature_delta': {
          // Signature is an atomic value — overwrite, not append.
          const existing = thinkingParts.get(event.index) ?? { thinking: '', signature: '' };
          thinkingParts.set(event.index, {
            thinking: existing.thinking,
            signature: event.signature,
          });
          break;
        }

        case 'input_json_delta': {
          const buf = toolBuffers.get(event.index);
          if (buf) buf.jsonBuf += event.partialJson;
          break;
        }

        case 'content_block_stop': {
          // Finalize tool_use and server_tool_use blocks
          const toolBuf = toolBuffers.get(event.index);
          if (toolBuf) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(toolBuf.jsonBuf);
            } catch (err: unknown) {
              // The block still has to be emitted, so the arguments are left
              // empty — but a caller reading `{}` as "the model sent no
              // arguments" would be reading a fabrication, so say so.
              log.warn(
                'tool arguments unparseable; block emitted with empty input',
                {
                  tool: toolBuf.name,
                  toolUseId: toolBuf.id,
                  err: err instanceof Error ? err.message : String(err),
                },
              );
            }
            contentBlocks.push({
              type: 'tool_use',
              id: toolBuf.id,
              name: toolBuf.name,
              input,
            });
            toolBuffers.delete(event.index);
          }
          break;
        }

        case 'message_delta':
          if (event.stopReason) stopReason = event.stopReason;
          if (event.usage) {
            // Usage deltas are cumulative snapshots of only the supplied fields.
            for (const key of Object.keys(event.usage) as Array<keyof UsageInfo>) {
              const value = event.usage[key];
              if (value !== undefined) usage[key] = value;
            }
          }
          break;

        case 'message_stop':
          break;

        case 'error':
          throw new Error(`[${event.errorType}] ${event.message}`);

        case 'retry':
          // The failed attempt's partial content is void; the next attempt
          // starts over from message_start.
          id = 'unknown';
          model = this.resolveModel(request);
          contentBlocks.length = 0;
          textParts.clear();
          thinkingParts.clear();
          toolBuffers.clear();
          stopReason = 'end_turn';
          usage = { input_tokens: 0, output_tokens: 0 };
          break;
      }
    }

    // Assemble final content: thinking blocks first, then text blocks, then tool blocks
    const allBlocks: ContentBlock[] = [];

    // Thinking blocks by index order (with signature preserved for subsequent turns)
    const thinkingEntries = Array.from(thinkingParts.entries()).sort((a, b) => a[0] - b[0]);
    for (const [, { thinking, signature }] of thinkingEntries) {
      if (thinking) {
        const thinkingBlock: ThinkingBlock = { type: 'thinking', thinking };
        if (signature) thinkingBlock.signature = signature;
        allBlocks.push(thinkingBlock);
      }
    }

    // Text blocks by index order
    const textEntries = Array.from(textParts.entries()).sort((a, b) => a[0] - b[0]);
    for (const [, text] of textEntries) {
      allBlocks.push({ type: 'text', text });
    }

    // Other content blocks (tool_use, images, etc.)
    allBlocks.push(...contentBlocks);

    return { id, content: allBlocks, stopReason, usage, model };
  }

  async *createMessageStream(
    request: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const body = await this.buildRequestBody(request);
    body.stream = true;

    const enableInterleavedThinking = request.thinking?.type === 'enabled';

    const url = `${this.baseUrl}/v1/messages${this.requestIdentity?.betaQueryParam ? '?beta=true' : ''}`;

    // Determine 529 strategy from query-source context.
    // providerOptions.querySource may be set by the query-loop.
    // Only truly background work (e.g. indexing) gets zero-retry abort.
    const querySource = request.providerOptions?.querySource as string | undefined;
    const strategy529: RetryStrategy =
      querySource === 'background'
        ? build529Strategy('background')
        : DEFAULT_RETRY_STRATEGY;

    const abortSignal = request.providerOptions?.signal as AbortSignal | undefined;

    // An exhausted overload budget escalates to a model switch only when the
    // caller has a model to switch to; otherwise overload is retried on the
    // ordinary budget like any other transient failure.
    const fallbackAvailable = request.providerOptions?.fallbackModelAvailable === true;

    // consecutive529 tracks 529s for the strategy's onMaxRetriesExceeded gate.
    let consecutive529 = 0;
    // consecutiveStreamingFailures tracks mid-stream failures for non-streaming fallback.
    let consecutiveStreamingFailures = 0;
    let lastError: Error | undefined;
    let lastStatus: number | null = null;
    let lastReason = '';
    // Wait chosen from the failed response (its Retry-After, else backoff).
    let nextDelayMs: number | undefined;
    let nonStreamingBody: Record<string, unknown> | undefined;
    let responseStarted = false;

    for (let attempt = 0; attempt <= DEFAULT_RETRY.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = nextDelayMs ?? delayForAttempt(DEFAULT_RETRY, attempt - 1);
        nextDelayMs = undefined;
        log.warn('request failed; retrying', {
          attempt,
          maxRetries: DEFAULT_RETRY.maxRetries,
          delayMs: Math.round(delayMs),
          status: lastStatus,
          reason: lastReason,
        });
        yield {
          type: 'retry',
          attempt,
          maxRetries: DEFAULT_RETRY.maxRetries,
          delayMs,
          status: lastStatus,
          message: lastReason,
        };
        await sleep(delayMs, abortSignal);
      }

      // Headers are rebuilt per attempt so x-stainless-retry-count is accurate.
      const headers = await this.buildHeaders(enableInterleavedThinking, request.providerOptions, attempt);

      // After MAX_STREAMING_FAILURES consecutive mid-stream failures, the
      // remaining attempts are non-streaming requests whose response is
      // re-wrapped as a StreamEvent sequence, so callers are unaffected.
      const streaming = consecutiveStreamingFailures < MAX_STREAMING_FAILURES;
      if (!streaming) nonStreamingBody ??= await this.buildNonStreamingBody(request);

      // ------------------------------------------------------------------
      // HTTP request
      // ------------------------------------------------------------------

      abortSignal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(streaming ? body : nonStreamingBody),
          signal: abortSignal,
        });
      } catch (err) {
        // Re-throw abort errors immediately — don't retry on abort
        if (isAbortError(err, abortSignal)) throw err;
        lastReason = describeFetchError(err);
        lastError = new ProviderError(lastReason, { provider: this.name, retryable: true });
        lastStatus = null;
        consecutive529 = 0;
        continue;
      }

      if (!response.ok) {
        const status = response.status;
        let errorBody: string;
        try {
          errorBody = await response.text();
        } catch (err) {
          if (isAbortError(err, abortSignal)) throw err;
          errorBody = '';
          log.warn('HTTP error body unavailable', { status, reason: describeFetchError(err) });
        }
        const retryDelayMs = httpRetryDelay(DEFAULT_RETRY, attempt, status, response.headers);

        if (retryDelayMs === null) {
          throw this.createHttpError(status, errorBody, { retryable: false, requestRejected: !responseStarted });
        }

        // ------------------------------------------------------------------
        // 529 overloaded — apply per-source strategy
        // ------------------------------------------------------------------
        if (status === 529) {
          if (!strategy529.shouldRetry(consecutive529, { status, message: errorBody })) {
            const action = strategy529.onMaxRetriesExceeded({ status, message: errorBody });
            if (action === 'abort') {
              throw this.createHttpError(status, errorBody, { retryable: true, retriesExhausted: true, requestRejected: !responseStarted });
            }
            if (fallbackAvailable) {
              throw new ModelFallbackError(
                `Anthropic API overloaded after ${consecutive529} retries`,
                { provider: 'Anthropic' },
              );
            }
          }
          consecutive529++;
        }

        if (attempt >= DEFAULT_RETRY.maxRetries) {
          throw this.createHttpError(status, errorBody, { retryable: true, retriesExhausted: true, requestRejected: !responseStarted });
        }

        if (status !== 529) consecutive529 = 0;
        lastError = this.createHttpError(status, errorBody, { retryable: true, requestRejected: !responseStarted });
        lastStatus = status;
        lastReason = apiErrorMessage(errorBody) ?? lastError.message;
        nextDelayMs = retryDelayMs;
        continue;
      }

      try {
        if (!streaming) {
          responseStarted = true;
          const json = (await response.json()) as Record<string, unknown>;
          if (json.error) {
            const error = json.error as { type?: string; message?: string };
            throw ProviderError.fromStreamError(this.name, error.type ?? 'unknown_error', error.message ?? 'Unknown API error');
          }
          if (!json.stop_reason || !Array.isArray(json.content)) {
            throw new Error('Non-streaming response is missing content or stop_reason');
          }
          yield* this.nonStreamingEvents(json, request);
          return;
        }

        for await (const chunk of parseSSEStream(response, abortSignal)) {
          const event = this.mapAnthropicEvent(chunk);
          if (!event) continue;
          if (event.type === 'error') {
            throw ProviderError.fromStreamError(this.name, event.errorType, event.message);
          }
          responseStarted = true;
          yield event;
          if (event.type === 'message_stop') return;
        }
        throw new Error('Stream ended without receiving message_stop');
      } catch (streamErr) {
        if (isAbortError(streamErr, abortSignal)) throw streamErr;
        if (streamErr instanceof ProviderError && !streamErr.retryable) throw streamErr;

        lastReason = describeFetchError(streamErr);
        const error = streamErr instanceof ProviderError ? streamErr : new ProviderError(lastReason, {
          provider: this.name,
          retryable: true,
        });
        lastError = error;
        lastStatus = error.statusCode ?? null;
        // A server error in a valid SSE frame does not mean streaming is broken.
        if (streaming && !(streamErr instanceof ProviderError)) consecutiveStreamingFailures++;
        if (lastStatus === 529) {
          const overload = { status: lastStatus, message: error.message };
          if (!strategy529.shouldRetry(consecutive529, overload)) {
            const action = strategy529.onMaxRetriesExceeded(overload);
            if (action === 'abort') throw withRetriesExhausted(error);
            if (fallbackAvailable) {
              throw new ModelFallbackError(
                `Anthropic API overloaded after ${consecutive529} retries`,
                { provider: this.name },
              );
            }
          }
          consecutive529++;
        } else {
          consecutive529 = 0;
        }
      }
    }

    throw withRetriesExhausted(lastError ?? new Error('Max retries exceeded'));
  }

  /** Request body for the non-streaming fallback. */
  private async buildNonStreamingBody(request: ProviderRequest): Promise<Record<string, unknown>> {
    const body = await this.buildRequestBody(request);
    body.stream = false;

    const originalMaxTokens = body.max_tokens as number;
    if (originalMaxTokens > MAX_NON_STREAMING_TOKENS) {
      body.max_tokens = MAX_NON_STREAMING_TOKENS;
    }

    // Adjust thinking budget_tokens to fit within the clamped max_tokens.
    // budget_tokens must be < max_tokens (Anthropic API requirement).
    const cappedMaxTokens = body.max_tokens as number;
    if (body.thinking && typeof body.thinking === 'object') {
      const thinking = body.thinking as Record<string, unknown>;
      if (thinking.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
        if (thinking.budget_tokens >= cappedMaxTokens) {
          thinking.budget_tokens = cappedMaxTokens - 1;
        }
      }
    }

    return body;
  }

  /**
   * Wrap a complete non-streaming response as the canonical `StreamEvent`
   * sequence callers of `createMessageStream()` expect:
   *   message_start → content_block_start → delta events →
   *   content_block_stop → message_delta → message_stop
   * so the caller never needs to know whether the response was streamed.
   */
  private *nonStreamingEvents(
    json: Record<string, unknown>,
    request: ProviderRequest,
  ): Generator<StreamEvent, void, undefined> {
    const msgId = (json.id as string | undefined) ?? 'unknown';
    const msgModel = (json.model as string | undefined) ?? this.resolveModel(request);
    const rawUsage = json.usage as Record<string, unknown> | undefined;
    const usage: UsageInfo = {
      input_tokens: (rawUsage?.input_tokens as number | undefined) ?? 0,
      output_tokens: (rawUsage?.output_tokens as number | undefined) ?? 0,
      cache_creation_input_tokens: rawUsage?.cache_creation_input_tokens as number | undefined,
      cache_read_input_tokens: rawUsage?.cache_read_input_tokens as number | undefined,
    };

    const rawDelta = json.delta as Record<string, unknown> | undefined;
    const stopReasonRaw =
      (rawDelta?.stop_reason as string | undefined) ??
      (json.stop_reason as string | undefined);
    const stopReason = stopReasonRaw ? this.mapStopReason(stopReasonRaw) : undefined;
    yield { type: 'message_start', id: msgId, model: msgModel, usage, stopReason };

    const rawContent = (json.content as Array<Record<string, unknown>> | undefined) ?? [];

    for (let index = 0; index < rawContent.length; index++) {
      const block = rawContent[index]!;
      const blockType = block.type as string;

      if (blockType === 'text') {
        const text = (block.text as string | undefined) ?? '';
        yield {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        };
        if (text) {
          yield { type: 'text_delta', index, text };
        }
        yield { type: 'content_block_stop', index };
      } else if (blockType === 'thinking') {
        const thinking = (block.thinking as string | undefined) ?? '';
        const signature = (block.signature as string | undefined) ?? '';
        yield {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' },
        };
        if (thinking) {
          yield { type: 'thinking_delta', index, thinking };
        }
        if (signature) {
          yield { type: 'signature_delta', index, signature };
        }
        yield { type: 'content_block_stop', index };
      } else if (blockType === 'tool_use') {
        const toolId = (block.id as string | undefined) ?? '';
        const toolName = (block.name as string | undefined) ?? '';
        const toolInput = block.input ?? {};
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: toolInput as Record<string, unknown>,
          },
        };
        // Emit the full JSON input as a single input_json_delta chunk
        const inputJson = JSON.stringify(toolInput);
        if (inputJson && inputJson !== '{}') {
          yield { type: 'input_json_delta', index, partialJson: inputJson };
        }
        yield { type: 'content_block_stop', index };
      } else {
        // Unknown block type — emit as text to avoid silent data loss
        const fallbackText = JSON.stringify(block);
        yield {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        };
        yield { type: 'text_delta', index, text: fallbackText };
        yield { type: 'content_block_stop', index };
      }
    }

    yield { type: 'message_delta', stopReason, usage };

    // message_stop
    yield { type: 'message_stop' };
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    if (!this.apiKey) return [];

    try {
      const url = `${this.baseUrl}/v1/models?limit=100`;
      const headers = await this.buildHeaders();
      // GET request — remove content-type (not needed for GET)
      delete (headers as Record<string, string | undefined>)['content-type'];

      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) return [];

      const json = (await response.json()) as Record<string, unknown>;
      const data = json?.data as Array<Record<string, unknown>> | undefined;
      if (!data || !Array.isArray(data)) return [];

      return data
        .filter((m) => typeof m.id === 'string')
        .map((m) => ({
          id: m.id as string,
          providerId: 'anthropic',
          name: (m.display_name as string | undefined) ?? (m.id as string),
          // The models endpoint reports no limits; these are placeholders.
          contextWindow: 200_000,
          maxOutputTokens: DEFAULT_MAX_TOKENS,
        }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<ProviderStatus> {
    if (!this.apiKey) {
      return { status: 'unavailable', reason: 'No API key configured' };
    }
    return { status: 'healthy' };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Build the Anthropic Messages API request body. */
  private async buildRequestBody(request: ProviderRequest): Promise<Record<string, unknown>> {
    assertImageRequestBudget(request.messages);
    // Strip [1m]/[2m] context-window suffix — the API only accepts canonical ids.
    const model = this.resolveModel(request).replace(/\[(1|2)m\]/gi, '');

    // The caller owns the output limit; the SDK does not guess it from the
    // model name.
    const effectiveMaxTokens =
      request.maxTokens !== undefined && request.maxTokens > 0
        ? request.maxTokens
        : DEFAULT_MAX_TOKENS;

    // ------------------------------------------------------------------
    // Thinking is sent exactly as requested; which style a model accepts
    // is the caller's decision.
    //   - When thinking is on, temperature MUST NOT be sent (API error).
    //   - budget_tokens must be < max_tokens.
    // ------------------------------------------------------------------
    const hasThinking = isThinkingRequested(request);

    let thinkingParam: Record<string, unknown> | undefined;
    if (request.thinking?.type === 'adaptive') {
      thinkingParam = { type: 'adaptive' };
    } else if (request.thinking?.type === 'enabled') {
      const budget = Math.min(effectiveMaxTokens - 1, request.thinking.budgetTokens);
      thinkingParam = { type: 'enabled', budget_tokens: budget };
    } else if (request.thinking?.type === 'disabled') {
      thinkingParam = { type: 'disabled' };
    }

    // Active thinking leaves sampling temperature under the provider's control.
    const temperature: number | undefined = hasThinking
      ? undefined
      : (request.temperature ?? 1);

    // ------------------------------------------------------------------
    // Apply cache breakpoints to messages.
    // Reads providerOptions.enableCaching (default true) and
    // providerOptions.extendedTtl (default false) from the request.
    // ------------------------------------------------------------------
    const enableCaching =
      (request.providerOptions?.enableCaching as boolean | undefined) ?? true;
    const extendedTtl =
      (request.providerOptions?.extendedTtl as boolean | undefined) ?? false;
    const skipCacheWrite =
      (request.providerOptions?.skipCacheWrite as boolean | undefined) ?? false;

    // Cast required: ContentBlock lacks an index signature but is structurally
    // compatible with ContentBlockLike at runtime. The cast is safe because
    // addCacheBreakpoints only reads .type and spreads block fields.
    const processedMessages = addCacheBreakpoints(
      request.messages as unknown as import('./cache-breakpoints.js').MessageLike[],
      { enableCaching, skipCacheWrite, extendedTtl },
    );

    // ------------------------------------------------------------------
    // System prompt — apply cache breakpoints when caching is enabled.
    // ------------------------------------------------------------------
    let systemField: unknown = undefined;
    if (request.systemPrompt) {
      if (enableCaching) {
        systemField = addSystemPromptCacheBreakpoint(
          request.systemPrompt as string | Array<{ type: 'text'; text: string }>,
          { extendedTtl },
        );
      } else {
        systemField = request.systemPrompt;
      }
    }

    // ------------------------------------------------------------------
    // Host-injected system prefix block — prepended as system[0].
    // ------------------------------------------------------------------
    if (this.requestIdentity?.systemPrefix && systemField !== undefined) {
      const prefixBlock = await this.requestIdentity.systemPrefix(request.messages, { signal: request.providerOptions?.signal as AbortSignal | undefined });
      if (typeof systemField === 'string') {
        systemField = [prefixBlock, { type: 'text', text: systemField }];
      } else if (Array.isArray(systemField)) {
        systemField = [prefixBlock, ...systemField];
      }
    }

    // ------------------------------------------------------------------
    // Assemble body
    // ------------------------------------------------------------------
    const body: Record<string, unknown> = {
      model,
      max_tokens: effectiveMaxTokens,
      messages: this.normalizeMessages(processedMessages),
    };

    if (systemField !== undefined) {
      body.system = systemField;
    }

    // Tools — normalize for the API:
    //   1. Names are already sanitized at the MCP bridge layer (normalizeNameForMCP)
    //   2. Ensure every input_schema carries `type: "object"`
    //   3. Mark last tool with cache_control for prompt caching
    if (request.tools && request.tools.length > 0) {
      const enableCachingForTools =
        (request.providerOptions?.enableCaching as boolean | undefined) ?? true;
      body.tools = request.tools.map((t, i) => {
        const schema = t.input_schema?.type
          ? t.input_schema
          : { type: 'object' as const, ...t.input_schema };
        const isLast = i === request.tools!.length - 1;
        return {
          name: t.name,
          description: t.description,
          input_schema: schema,
          ...(isLast && enableCachingForTools
            ? { cache_control: { type: 'ephemeral' } }
            : {}),
        };
      });
    }

    // Temperature (omitted when thinking is active)
    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    // Tool choice
    if (request.toolChoice) {
      body.tool_choice = request.toolChoice;
    }

    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.topK !== undefined) body.top_k = request.topK;
    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop_sequences = request.stopSequences;
    }

    // Extended thinking block (only when resolved above)
    if (thinkingParam !== undefined) {
      body.thinking = thinkingParam;
    }

    // ------------------------------------------------------------------
    // Host-injected body fields: metadata, context_management, output_config
    // ------------------------------------------------------------------
    if (this.requestIdentity?.metadata) {
      body.metadata = this.requestIdentity.metadata;
    }
    if (this.requestIdentity?.contextManagement) {
      body.context_management = this.requestIdentity.contextManagement;
    }

    const outputConfig: Record<string, unknown> = {};
    const effort = request.providerOptions?.effort as string | undefined;
    if (effort) {
      outputConfig.effort = effort;
    }
    const taskBudget = request.providerOptions?.taskBudget as Record<string, unknown> | undefined;
    if (taskBudget) {
      outputConfig.task_budget = { type: 'tokens', ...taskBudget };
    }
    if (Object.keys(outputConfig).length > 0) {
      body.output_config = outputConfig;
    }

    assertImageBodyBudget(body);
    return body;
  }

  /** Normalize messages to the Anthropic wire format. */
  private normalizeMessages(
    messages: Array<{ role: string; content: unknown }>,
  ): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content };
      }

      // Array of content blocks — map to Anthropic format.
      // cache_control is preserved when present (prompt caching breakpoints).
      const blocks = msg.content as ContentBlock[];
      const apiBlocks = blocks.map((block) => {
        // Helper: include cache_control if the block carries one
        const cc = (block as unknown as Record<string, unknown>).cache_control;
        const withCc = cc ? { cache_control: cc } : {};

        switch (block.type) {
          case 'text':
            return { type: 'text', text: (block as TextBlock).text, ...withCc };
          case 'thinking': {
            const tb = block as ThinkingBlock;
            // Thinking blocks cannot carry cache_control — omit withCc intentionally
            return {
              type: 'thinking',
              thinking: tb.thinking,
              ...(tb.signature ? { signature: tb.signature } : {}),
            };
          }
          case 'tool_use': {
            const tu = block as ToolUseBlock;
            return { type: 'tool_use', id: tu.id, name: tu.name, input: tu.input, ...withCc };
          }
          case 'tool_result': {
            const tr = block as { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };
            return {
              type: 'tool_result',
              tool_use_id: tr.tool_use_id,
              content: tr.content,
              ...(tr.is_error ? { is_error: true } : {}),
              ...withCc,
            };
          }
          case 'image': {
            const img = block as { type: 'image'; source: { type: string; media_type: string; data: string } };
            return { type: 'image', source: img.source, ...withCc };
          }
          case 'document': {
            const doc = block as { type: 'document'; source: { type: string; media_type: string; data: string } };
            return { type: 'document', source: doc.source, ...withCc };
          }
          default:
            return block;
        }
      });

      return { role: msg.role, content: apiBlocks };
    });
  }

  /**
   * Build HTTP headers for Anthropic API requests.
   *
   * Betas are built dynamically via `buildBetas()` rather than from a
   * static constructor-level list. The constructor-supplied `this.betas` are
   * still merged in as extra/override betas so callers retain the ability to
   * inject additional beta strings.
   */
  private async buildHeaders(
    enableInterleavedThinking = false,
    providerOptions?: Record<string, unknown>,
    attempt = 0,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion,
    };

    // Host-injected identity headers
    if (this.requestIdentity) {
      if (this.requestIdentity.headers) {
        Object.assign(headers, this.requestIdentity.headers);
      }
      if (this.requestIdentity.headersForAttempt) {
        Object.assign(headers, await this.requestIdentity.headersForAttempt(attempt, { signal: providerOptions?.signal as AbortSignal | undefined }));
      }
      headers['x-client-request-id'] = generateRequestId();
    }

    const dynamicBetas = buildBetas({
      enableInterleavedThinking,
      enableContextManagement: !!this.requestIdentity?.contextManagement,
      enable1mContext: (providerOptions?.enable1mContext as boolean | undefined) ?? false,
      enableTaskBudgets: !!providerOptions?.taskBudget,
      extraBetas: this.betas,
    });

    if (dynamicBetas.length > 0) {
      headers['anthropic-beta'] = dynamicBetas.join(',');
    }

    // Merge extra headers (may override any of the above)
    for (const [key, value] of Object.entries(this.extraHeaders)) {
      headers[key] = value;
    }

    return headers;
  }

  /**
   * Map a raw Anthropic SSE event (parsed JSON object) to a StreamEvent.
   * Returns null for events that should be skipped (e.g. ping).
   */
  private mapAnthropicEvent(raw: Record<string, unknown>): StreamEvent | null {
    const eventType = (raw.__event as string) ?? (raw.type as string);

    switch (eventType) {
      case 'message_start': {
        const message = raw.message as Record<string, unknown> | undefined;
        const id = (message?.id as string) ?? 'unknown';
        const model = (message?.model as string) ?? '';
        const rawUsage = message?.usage as Record<string, unknown> | undefined;
        const usage: UsageInfo = {
          input_tokens: (rawUsage?.input_tokens as number) ?? 0,
          output_tokens: (rawUsage?.output_tokens as number) ?? 0,
          cache_creation_input_tokens: rawUsage?.cache_creation_input_tokens as number | undefined,
          cache_read_input_tokens: rawUsage?.cache_read_input_tokens as number | undefined,
        };
        return { type: 'message_start', id, model, usage };
      }

      case 'content_block_start': {
        const index = (raw.index as number) ?? 0;
        const cb = raw.content_block as Record<string, unknown>;
        const content_block = this.mapContentBlock(cb);
        return { type: 'content_block_start', index, content_block };
      }

      case 'content_block_delta': {
        const index = (raw.index as number) ?? 0;
        const delta = raw.delta as Record<string, unknown>;
        const deltaType = delta?.type as string;

        switch (deltaType) {
          case 'text_delta':
            return { type: 'text_delta', index, text: (delta.text as string) ?? '' };
          case 'thinking_delta':
            return { type: 'thinking_delta', index, thinking: (delta.thinking as string) ?? '' };
          case 'input_json_delta':
            return { type: 'input_json_delta', index, partialJson: (delta.partial_json as string) ?? '' };
          case 'signature_delta':
            return { type: 'signature_delta', index, signature: (delta.signature as string) ?? '' };
          default:
            return null;
        }
      }

      case 'content_block_stop':
        return { type: 'content_block_stop', index: (raw.index as number) ?? 0 };

      case 'message_delta': {
        const delta = raw.delta as Record<string, unknown> | undefined;
        const rawUsage = raw.usage as Record<string, unknown> | undefined;
        const sr = delta?.stop_reason as string | undefined;
        return {
          type: 'message_delta',
          stopReason: sr ? this.mapStopReason(sr) : undefined,
          usage: rawUsage
            ? {
                ...(typeof rawUsage.input_tokens === 'number' ? { input_tokens: rawUsage.input_tokens } : {}),
                ...(typeof rawUsage.output_tokens === 'number' ? { output_tokens: rawUsage.output_tokens } : {}),
                ...(typeof rawUsage.cache_creation_input_tokens === 'number' ? { cache_creation_input_tokens: rawUsage.cache_creation_input_tokens } : {}),
                ...(typeof rawUsage.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: rawUsage.cache_read_input_tokens } : {}),
              }
            : undefined,
        };
      }

      case 'message_stop':
        return { type: 'message_stop' };

      case 'error': {
        const error = raw.error as Record<string, unknown> | undefined;
        return {
          type: 'error',
          errorType: (error?.type as string) ?? 'unknown_error',
          message: (error?.message as string) ?? 'Unknown error',
        };
      }

      case 'ping':
        return null;

      default:
        return null;
    }
  }

  /** Map a raw content block object to a ContentBlock type. */
  private mapContentBlock(raw: Record<string, unknown>): ContentBlock {
    switch (raw.type as string) {
      case 'text':
        return { type: 'text', text: (raw.text as string) ?? '' };
      case 'thinking': {
        const block: ThinkingBlock = {
          type: 'thinking',
          thinking: (raw.thinking as string) ?? '',
        };
        if (raw.signature) block.signature = raw.signature as string;
        return block;
      }
      case 'tool_use':
        return {
          type: 'tool_use',
          id: (raw.id as string) ?? '',
          name: (raw.name as string) ?? '',
          input: (raw.input as Record<string, unknown>) ?? {},
        };
      case 'signature':
        return { type: 'signature', signature: (raw.signature as string) ?? '' };
      default:
        return { type: 'text', text: '' };
    }
  }

  /** Map Anthropic stop reason string to StopReason. */
  private mapStopReason(reason: string): StopReason {
    switch (reason) {
      case 'end_turn':
        return 'end_turn';
      case 'stop_sequence':
        return 'stop_sequence';
      case 'max_tokens':
        return 'max_tokens';
      case 'tool_use':
        return 'tool_use';
      default:
        return reason;
    }
  }

  /** Create a descriptive error from an HTTP error response. */
  private createHttpError(
    status: number,
    body: string,
    options?: { retryable?: boolean; retriesExhausted?: boolean; requestRejected?: boolean },
  ): ProviderError {
    return ProviderError.fromHttpResponse('Anthropic', status, body, options);
  }
}
