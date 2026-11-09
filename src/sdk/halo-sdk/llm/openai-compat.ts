/**
 * @module llm/openai-compat
 * OpenAI Chat Completions compatible provider implementation.
 * Supports any provider exposing an OpenAI-compatible API (OpenAI, DeepSeek,
 * Groq, Ollama, Qwen/DashScope, OpenRouter, etc.).
 * @license MIT
 */

import type {
  ContentBlock,
  LlmProvider,
  Message,
  ProviderCapabilities,
  ProviderModelInfo,
  ProviderRequest,
  ProviderResponse,
  ProviderStatus,
  StopReason,
  StreamEvent,
  SystemPrompt,
  SystemPromptBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  UsageInfo,
} from '../types/provider.js';
import { parseSSEStream } from './stream-parser.js';
import { applyModelQuirks, applyStreamQuirks, isQuirkyModel, isXmlThinkModel, isOSeriesModel, ThinkTagParser } from './model-quirks.js';
import {
  DEFAULT_RETRY,
  delayForAttempt,
  describeFetchError,
  httpRetryDelay,
  sleep,
} from '../utils/retry.js';
import { apiErrorMessage, isAbortError, ProviderError, withRetriesExhausted } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { assertImageBodyBudget, assertImageRequestBudget } from './image-request-budget.js';

const log = getLogger('OpenAiCompatProvider');

// Usage may follow finish_reason; providers that leave the body open must not
// hold a completed answer indefinitely.
const STREAM_USAGE_GRACE_MS = 1_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OpenAiCompatProviderConfig {
  /** Unique provider identifier (e.g. "openai", "deepseek", "groq") */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** Base URL including path prefix (e.g. "https://api.groq.com/openai/v1") */
  baseUrl: string;
  /** API key (sent as Authorization: Bearer) */
  apiKey?: string;
  /** Additional headers to send on every request */
  headers?: Record<string, string>;
  /** Default model to use when none is specified */
  defaultModel?: string;
  /** Provider-specific behavioural quirks */
  quirks?: ProviderQuirks;
}

/** Provider-specific behavioural quirks. */
export interface ProviderQuirks {
  /** Truncate tool call IDs to at most this many characters. */
  toolIdMaxLen?: number;
  /** Strip all non-alphanumeric characters from tool IDs. */
  toolIdAlphanumericOnly?: boolean;
  /** Send `stream_options.include_usage` when streaming. */
  includeUsageInStream?: boolean;
  /** Override default temperature when request doesn't specify one. */
  defaultTemperature?: number;
  /** Insert assistant "Done." between tool→user message transitions. */
  fixToolUserSequence?: boolean;
  /** Name of the JSON field carrying extended reasoning text (e.g. "reasoning_content"). */
  reasoningField?: string;
  /** Forward reasoning_effort for compatible providers beyond OpenAI o-series. */
  reasoningEffort?: boolean;
}

// ---------------------------------------------------------------------------
// OpenAiCompatProvider
// ---------------------------------------------------------------------------

export class OpenAiCompatProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly defaultModel: string | undefined;
  private readonly quirks: ProviderQuirks;

  constructor(config: OpenAiCompatProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.extraHeaders = config.headers ?? {};
    this.defaultModel = config.defaultModel;
    this.quirks = config.quirks ?? {};
  }

  private resolveModel(request: ProviderRequest): string {
    const model = request.model || this.defaultModel;
    if (!model) {
      throw new Error('No model specified: set ProviderRequest.model or OpenAiCompatProviderConfig.defaultModel.');
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
      thinking: !!this.quirks.reasoningField,
      imageInput: true,
      pdfInput: false,
      audioInput: false,
      videoInput: false,
      caching: false,
      systemPromptStyle: 'system_message',
    };
  }

  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    const body = this.buildRequestBody(request, false);
    const url = `${this.baseUrl}/chat/completions`;
    const abortSignal = request.providerOptions?.signal as AbortSignal | undefined;

    const provider = this;
    const connecting = this.requestWithRetry(
      url,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      abortSignal,
      async function* (response) {
        const json = await response.json();
        return provider.parseNonStreamingResponse(json as Record<string, unknown>, request.model);
      },
    );
    let step = await connecting.next();
    while (!step.done) step = await connecting.next();
    let result = step.value;

    // Apply model quirks
    if (isQuirkyModel(request.model)) {
      result = applyModelQuirks(request.model, result);
    }

    return result;
  }

  async *createMessageStream(
    request: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const body = this.buildRequestBody(request, true);
    const url = `${this.baseUrl}/chat/completions`;
    const abortSignal = request.providerOptions?.signal as AbortSignal | undefined;

    yield* this.requestWithRetry(
      url,
      {
        method: 'POST',
        headers: { ...this.buildHeaders(), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      },
      abortSignal,
      (response) => this.parseStreamResponse(response, request, abortSignal),
    );
  }

  private async *parseStreamResponse(
    response: Response,
    request: ProviderRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const modelId = this.resolveModel(request);
    const reasoningField = this.quirks.reasoningField;

    let messageStarted = false;
    let messageId = 'unknown';
    let modelName = '';
    const toolCallBuffers: Map<number, { id: string; name: string; jsonBuf: string }> = new Map();

    // Lazy content block tracking — blocks are opened on first content arrival,
    // not eagerly. This prevents index collisions when reasoning precedes text
    // (e.g. DeepSeek R1: reasoning_content arrives before content).
    let nextBlockIndex = 0;       // next available block slot
    let reasoningBlockIndex = -1; // -1 = not yet started
    let textBlockIndex = -1;      // -1 = not yet started
    const toolBlockIndices = new Map<number, number>();

    // Reasoning field detection — ordered by priority.
    // Covers: DeepSeek R1 (reasoning_content), OpenAI o-series (reasoning),
    // MiniMax (thinking_content), and generic fallbacks.
    const COMMON_REASONING_FIELDS = [
      'reasoning_content',
      'thinking_content',
      'reasoning_text',
      'reasoning',
    ];
    const fieldsToCheck: string[] = [];
    if (reasoningField) {
      fieldsToCheck.push(reasoningField);
      for (const f of COMMON_REASONING_FIELDS) {
        if (f !== reasoningField) fieldsToCheck.push(f);
      }
    } else {
      fieldsToCheck.push(...COMMON_REASONING_FIELDS);
    }

    // Stateful <think> tag parser — one instance per streaming request.
    // Required for Qwen/GLM models that embed thinking in XML tags across chunks.
    const thinkTagParser = isXmlThinkModel(modelId) ? new ThinkTagParser() : null;

    // Buffer for events collected during each chunk; flushed at end of chunk loop body.
    const pendingEvents: StreamEvent[] = [];

    const closeProseBlock = (): void => {
      const index = reasoningBlockIndex !== -1 ? reasoningBlockIndex : textBlockIndex;
      if (index !== -1) pendingEvents.push({ type: 'content_block_stop', index });
      reasoningBlockIndex = -1;
      textBlockIndex = -1;
    };

    /** Lazily open the reasoning/thinking content block. */
    const ensureReasoningBlock = (): number => {
      if (reasoningBlockIndex === -1) {
        closeProseBlock();
        reasoningBlockIndex = nextBlockIndex++;
        pendingEvents.push({
          type: 'content_block_start',
          index: reasoningBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        });
      }
      return reasoningBlockIndex;
    };

    /** Lazily open the text content block. */
    const ensureTextBlock = (): number => {
      if (textBlockIndex === -1) {
        closeProseBlock();
        textBlockIndex = nextBlockIndex++;
        pendingEvents.push({
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      return textBlockIndex;
    };

    let finished = false;
    let usageTimer: ReturnType<typeof setTimeout> | undefined;
    const streamController = new AbortController();
    const abortStream = () => streamController.abort(signal?.reason);
    signal?.addEventListener('abort', abortStream, { once: true });
    if (signal?.aborted) abortStream();

    try {
      for await (const chunk of parseSSEStream(response, streamController.signal)) {
        pendingEvents.length = 0;
        if (chunk.error) {
          const error = chunk.error as { type?: string; message?: string };
          throw ProviderError.fromStreamError(this.name, error.type ?? 'unknown_error', error.message ?? 'Unknown stream error');
        }
        if (finished) {
          if (chunk.usage) {
            yield { type: 'message_delta', usage: this.parseUsage(chunk.usage as Record<string, unknown>) };
            break;
          }
          continue;
        }

        // Emit message_start on first chunk
        if (!messageStarted) {
          if (chunk.id) messageId = chunk.id as string;
          if (chunk.model) modelName = chunk.model as string;
          pendingEvents.push({
            type: 'message_start',
            id: messageId,
            model: modelName,
            usage: { input_tokens: 0, output_tokens: 0 },
          });
          messageStarted = true;
        }

        const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
        if (!choices || choices.length === 0) {
          // Check for usage-only chunk
          if (chunk.usage) {
            const usage = this.parseUsage(chunk.usage as Record<string, unknown>);
            let evt: StreamEvent = { type: 'message_delta', usage };
            if (isQuirkyModel(modelId)) evt = applyStreamQuirks(modelId, evt);
            pendingEvents.push(evt);
          }
          for (const e of pendingEvents) yield e;
          continue;
        }

        const choice = choices[0];
        const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};

        // Reasoning / thinking extraction
        // 1. Flat string field (DeepSeek R1, MiniMax, OpenAI o-series, etc.)
        let reasoningHandled = false;
        for (const field of fieldsToCheck) {
          const reasoning = delta[field] as string | undefined;
          if (reasoning) {
            const idx = ensureReasoningBlock();
            let evt: StreamEvent = { type: 'reasoning_delta', index: idx, reasoning };
            if (isQuirkyModel(modelId)) evt = applyStreamQuirks(modelId, evt);
            pendingEvents.push(evt);
            reasoningHandled = true;
            break;
          }
        }

        // 2. Structured delta.thinking field (content/signature sub-fields).
        //    Some providers send: delta.thinking = { content: "...", signature: "..." }
        if (!reasoningHandled) {
          const structuredThinking = delta.thinking as Record<string, unknown> | undefined;
          if (structuredThinking) {
            if (typeof structuredThinking.content === 'string' && structuredThinking.content) {
              const idx = ensureReasoningBlock();
              pendingEvents.push({ type: 'reasoning_delta', index: idx, reasoning: structuredThinking.content });
            }
            if (typeof structuredThinking.signature === 'string' && structuredThinking.signature) {
              const idx = ensureReasoningBlock();
              pendingEvents.push({ type: 'signature_delta', index: idx, signature: structuredThinking.signature });
            }
          }
        }

        // Text content delta
        const content = delta.content as string | undefined;
        if (content) {
          if (thinkTagParser) {
            // XML think-tag models (Qwen/GLM): stateful parser splits the chunk
            // into reasoning_delta and text_delta events across chunk boundaries.
            // Post-process to assign correct lazy block indices.
            for (const evt of thinkTagParser.process(content, 0)) {
              if (evt.type === 'reasoning_delta') {
                const idx = ensureReasoningBlock();
                pendingEvents.push({ ...evt, index: idx });
              } else if (evt.type === 'text_delta') {
                const idx = ensureTextBlock();
                pendingEvents.push({ ...evt, index: idx });
              } else {
                pendingEvents.push(evt);
              }
            }
          } else {
            const idx = ensureTextBlock();
            let evt: StreamEvent = { type: 'text_delta', index: idx, text: content };
            if (isQuirkyModel(modelId)) evt = applyStreamQuirks(modelId, evt);
            pendingEvents.push(evt);
          }
        }

        // Tool call deltas
        const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCalls) {
          closeProseBlock();
          for (const tc of toolCalls) {
            const tcIndex = (tc.index as number) ?? 0;
            let blockIndex = toolBlockIndices.get(tcIndex);
            if (blockIndex === undefined) {
              blockIndex = nextBlockIndex++;
              toolBlockIndices.set(tcIndex, blockIndex);
            }

            // New tool call — emit ContentBlockStart
            if (tc.id) {
              const func = tc.function as Record<string, unknown> | undefined;
              const name = (func?.name as string) ?? '';
              const tcId = tc.id as string;
              toolCallBuffers.set(blockIndex, { id: tcId, name, jsonBuf: '' });
              pendingEvents.push({
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'tool_use', id: tcId, name, input: {} },
              });
            }

            // Argument fragment
            const func = tc.function as Record<string, unknown> | undefined;
            const argsFrag = func?.arguments as string | undefined;
            if (argsFrag) {
              const buf = toolCallBuffers.get(blockIndex);
              if (buf) buf.jsonBuf += argsFrag;
              pendingEvents.push({
                type: 'input_json_delta',
                index: blockIndex,
                partialJson: argsFrag,
              });
            }
          }
        }

        // finish_reason — close all opened content blocks in index order
        const finishReason = choice.finish_reason;
        if (typeof finishReason === 'string' && finishReason && finishReason !== 'null') {
          for (const event of thinkTagParser?.flush(0) ?? []) {
            if (event.type === 'reasoning_delta') {
              pendingEvents.push({ ...event, index: ensureReasoningBlock() });
            } else if (event.type === 'text_delta') {
              pendingEvents.push({ ...event, index: ensureTextBlock() });
            }
          }
          closeProseBlock();

          // Close tool blocks
          const indices = Array.from(toolCallBuffers.keys()).sort((a, b) => a - b);
          for (const idx of indices) {
            pendingEvents.push({ type: 'content_block_stop', index: idx });
          }

          const stopReason = this.mapFinishReason(finishReason);
          const usageVal = chunk.usage as Record<string, unknown> | undefined;
          const usage = usageVal ? this.parseUsage(usageVal) : undefined;

          pendingEvents.push({ type: 'message_delta', stopReason, usage });
          finished = true;
          if (!usage) {
            usageTimer = setTimeout(() => streamController.abort(), STREAM_USAGE_GRACE_MS);
          }
          for (const e of pendingEvents) yield e;
          if (usage) break;
          continue;
        }

        for (const e of pendingEvents) yield e;
      }
    } catch (err) {
      if (signal?.aborted || !finished) throw err;
      log.warn('completed response usage tail unavailable', {
        provider: this.id,
        reason: streamController.signal.aborted ? 'usage deadline exceeded' : describeFetchError(err),
      });
    } finally {
      clearTimeout(usageTimer);
      signal?.removeEventListener('abort', abortStream);
    }

    signal?.throwIfAborted();
    if (!finished) {
      throw new ProviderError('Stream ended without receiving finish_reason', {
        retryable: true,
        provider: this.name,
      });
    }
    yield { type: 'message_stop' };
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const url = `${this.baseUrl}/models`;
    const headers = this.buildHeaders();

    try {
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) return [];

      const json = (await response.json()) as Record<string, unknown>;
      const data = json?.data as Array<Record<string, unknown>> | undefined;
      if (!data) return [];

      return data
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id as string,
          providerId: this.id,
          name: (m.id as string) ?? '',
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
        }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<ProviderStatus> {
    const isLocal =
      this.baseUrl.includes('localhost') ||
      this.baseUrl.includes('127.0.0.1') ||
      this.baseUrl.includes('::1');

    if (!this.apiKey && !isLocal) {
      return { status: 'unavailable', reason: 'No API key configured' };
    }

    try {
      const url = `${this.baseUrl}/models`;
      const response = await fetch(url, { method: 'GET', headers: this.buildHeaders() });
      if (response.ok) return { status: 'healthy' };
      return { status: 'unavailable', reason: `models endpoint returned ${response.status}` };
    } catch (err) {
      return { status: 'unavailable', reason: String(err) };
    }
  }

  // -----------------------------------------------------------------------
  // Request building
  // -----------------------------------------------------------------------

  private buildRequestBody(
    request: ProviderRequest,
    stream: boolean,
  ): Record<string, unknown> {
    assertImageRequestBudget(request.messages);
    const model = this.resolveModel(request);
    const messages = this.toOpenAiMessages(request.messages, request.systemPrompt);

    // O-series models (o1, o3, o4-*) use a different parameter set:
    // - `max_completion_tokens` replaces `max_tokens`
    // - `temperature` is not supported (fixed at 1)
    // - `reasoning_effort` (low/medium/high) controls thinking depth
    const oSeries = isOSeriesModel(model);

    const body: Record<string, unknown> = {
      model,
      messages,
      stream,
    };

    // Token limit: o-series uses max_completion_tokens; others use max_tokens
    if (request.maxTokens != null) {
      if (oSeries) {
        body.max_completion_tokens = request.maxTokens;
      } else {
        body.max_tokens = request.maxTokens;
      }
    }

    if (stream && this.quirks.includeUsageInStream) {
      body.stream_options = { include_usage: true };
    }

    // Tools
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    // Temperature: o-series models do not accept a temperature parameter.
    if (!oSeries) {
      const temperature = request.temperature ?? this.quirks.defaultTemperature;
      if (temperature !== undefined) body.temperature = temperature;
    }

    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop = request.stopSequences;
    }

    if ((oSeries || this.quirks.reasoningEffort) && request.providerOptions?.reasoning_effort) {
      body.reasoning_effort = request.providerOptions.reasoning_effort;
    }

    assertImageBodyBudget(body);
    return body;
  }

  /** Convert our unified Message format to OpenAI chat messages. */
  private toOpenAiMessages(
    messages: Message[],
    systemPrompt?: SystemPrompt,
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    // System prompt as first message
    if (systemPrompt) {
      if (typeof systemPrompt === 'string') {
        result.push({ role: 'system', content: systemPrompt });
      } else {
        // SystemPromptBlock[] — concatenate text
        const text = (systemPrompt as SystemPromptBlock[])
          .map((b) => b.text)
          .join('\n\n');
        result.push({ role: 'system', content: text });
      }
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      // Content blocks — need to map to OpenAI format
      const blocks = msg.content as ContentBlock[];

      if (msg.role === 'assistant') {
        // Collect text content and tool calls from assistant message
        let textContent = '';
        const toolCalls: Array<Record<string, unknown>> = [];

        for (const block of blocks) {
          switch (block.type) {
            case 'text':
              textContent += (block as TextBlock).text;
              break;
            case 'tool_use': {
              const tu = block as ToolUseBlock;
              toolCalls.push({
                id: this.scrubToolId(tu.id),
                type: 'function',
                function: {
                  name: tu.name,
                  arguments: JSON.stringify(tu.input),
                },
              });
              break;
            }
            // Thinking/signature blocks are not sent to OpenAI
          }
        }

        const assistantMsg: Record<string, unknown> = { role: 'assistant' };
        if (textContent) assistantMsg.content = textContent;
        else if (toolCalls.length === 0) assistantMsg.content = '';
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        result.push(assistantMsg);
      } else if (msg.role === 'user') {
        // Check for tool_result blocks — these become separate tool messages in OpenAI
        const toolResults: ToolResultBlock[] = [];
        const otherBlocks: ContentBlock[] = [];

        for (const block of blocks) {
          if (block.type === 'tool_result') {
            toolResults.push(block as ToolResultBlock);
          } else {
            otherBlocks.push(block);
          }
        }

        // OpenAI tool messages accept text, not image_url parts. Deliver images
        // in a following user message while keeping each tool call paired.
        const imageBlocks: ContentBlock[] = [];
        for (const tr of toolResults) {
          const content = typeof tr.content === 'string'
            ? tr.content
            : tr.content.filter((block) => block.type === 'text')
                .map((block) => (block as TextBlock).text).join('\n');
          result.push({
            role: 'tool',
            tool_call_id: this.scrubToolId(tr.tool_use_id),
            content,
          });
          if (Array.isArray(tr.content)) {
            const images = tr.content.filter((block) => block.type === 'image');
            if (images.length > 0) {
              imageBlocks.push({ type: 'text', text: `Images from tool result ${tr.tool_use_id}:` }, ...images);
            }
          }
        }

        // Emit remaining user content
        if (otherBlocks.length > 0 || imageBlocks.length > 0) {
          const userContent = this.mapUserContent([...imageBlocks, ...otherBlocks]);
          result.push({ role: 'user', content: userContent });
        } else if (toolResults.length === 0) {
          // Empty user message
          result.push({ role: 'user', content: '' });
        }
      }
    }

    // Apply fix_tool_user_sequence quirk
    if (this.quirks.fixToolUserSequence) {
      this.applyFixToolUserSequence(result);
    }

    return result;
  }

  /** Map user content blocks to OpenAI content format. */
  private mapUserContent(
    blocks: ContentBlock[],
  ): string | Array<Record<string, unknown>> {
    // If all blocks are text, return a simple string
    const allText = blocks.every((b) => b.type === 'text');
    if (allText) {
      return blocks.map((b) => (b as TextBlock).text).join('');
    }

    // Mixed content — use the array format
    return blocks.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: (block as TextBlock).text };
        case 'image': {
          const img = block as { type: 'image'; source: { type: string; media_type: string; data: string } };
          return {
            type: 'image_url',
            image_url: {
              url: `data:${img.source.media_type};base64,${img.source.data}`,
            },
          };
        }
        default:
          return { type: 'text', text: '' };
      }
    });
  }

  /** Scrub a tool-call ID according to configured quirks. */
  private scrubToolId(id: string): string {
    let s = id;
    if (this.quirks.toolIdAlphanumericOnly) {
      s = s.replace(/[^a-zA-Z0-9]/g, '');
    }
    if (this.quirks.toolIdMaxLen) {
      const truncated = s.slice(0, this.quirks.toolIdMaxLen);
      s = truncated.padEnd(this.quirks.toolIdMaxLen, '0');
    }
    return s;
  }

  /**
   * Insert `{"role":"assistant","content":"Done."}` between any
   * tool message immediately followed by a user message.
   */
  private applyFixToolUserSequence(messages: Array<Record<string, unknown>>): void {
    let i = 0;
    while (i + 1 < messages.length) {
      if (messages[i].role === 'tool' && messages[i + 1].role === 'user') {
        messages.splice(i + 1, 0, { role: 'assistant', content: 'Done.' });
        i += 2;
      } else {
        i++;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Response parsing
  // -----------------------------------------------------------------------

  /** Parse a non-streaming OpenAI Chat Completions response. */
  private parseNonStreamingResponse(
    json: Record<string, unknown>,
    model: string,
  ): ProviderResponse {
    const id = (json.id as string) ?? 'unknown';
    const modelReported = (json.model as string) ?? model;
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;

    const content: ContentBlock[] = [];

    // Reasoning / thinking content — must appear before text blocks to preserve
    // the logical ordering (think → respond) that the query-loop expects.
    // Checks (in priority order):
    //   1. Structured `thinking` field: { content: string, signature?: string }
    //      (providers mirroring Anthropic extended thinking format)
    //   2. Flat string fields: reasoning_content (DeepSeek R1 / Kimi),
    //      thinking_content (MiniMax), reasoning_text, reasoning (OpenAI o-series)
    const structuredThinking = message?.thinking as Record<string, unknown> | undefined;
    if (structuredThinking && typeof structuredThinking.content === 'string' && structuredThinking.content) {
      const block: ThinkingBlock = { type: 'thinking', thinking: structuredThinking.content };
      if (typeof structuredThinking.signature === 'string' && structuredThinking.signature) {
        block.signature = structuredThinking.signature;
      }
      content.push(block);
    } else {
      const REASONING_FIELDS = ['reasoning_content', 'thinking_content', 'reasoning_text', 'reasoning'];
      for (const field of REASONING_FIELDS) {
        const reasoning = message?.[field] as string | undefined;
        if (reasoning) {
          content.push({ type: 'thinking', thinking: reasoning } as ThinkingBlock);
          break;
        }
      }
    }

    // Text content
    const textContent = message?.content as string | undefined;
    if (textContent) {
      content.push({ type: 'text', text: textContent });
    }

    // Tool calls
    const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const func = tc.function as Record<string, unknown>;
        const name = (func?.name as string) ?? '';
        const argsStr = (func?.arguments as string) ?? '{}';
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(argsStr);
        } catch (err: unknown) {
          // Emitted with empty input because the block shape requires it —
          // logged so an empty input is never mistaken for "no arguments sent".
          log.warn('tool arguments unparseable; block emitted with empty input', {
            tool: name,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        content.push({
          type: 'tool_use',
          id: (tc.id as string) ?? '',
          name,
          input,
        });
      }
    }

    // Ensure non-empty content
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    const finishReason = (choice?.finish_reason as string) ?? 'stop';
    const stopReason = this.mapFinishReason(finishReason);

    const usage = this.parseUsage(json.usage as Record<string, unknown> | undefined);

    return { id, content, stopReason, usage, model: modelReported };
  }

  /** Map OpenAI finish_reason to our StopReason. */
  private mapFinishReason(reason: string): StopReason {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'content_filter':
        return 'content_filtered';
      default:
        return reason;
    }
  }

  /** Parse usage info from OpenAI response. */
  private parseUsage(usage?: Record<string, unknown>): UsageInfo {
    if (!usage) {
      return { input_tokens: 0, output_tokens: 0 };
    }
    const inputTokens = (usage.prompt_tokens as number) ?? 0;
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const reportedCache = details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
    const cacheRead = typeof reportedCache === 'number' && Number.isFinite(reportedCache)
      ? Math.max(0, Math.min(inputTokens, reportedCache)) : 0;
    return {
      input_tokens: inputTokens - cacheRead,
      output_tokens: (usage.completion_tokens as number) ?? 0,
      ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    };
  }

  /** Build HTTP headers for OpenAI-compatible API requests. */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    for (const [key, value] of Object.entries(this.extraHeaders)) {
      headers[key] = value;
    }

    return headers;
  }

  /** HTTP and response-body failures share one budget for each model request. */
  private async *requestWithRetry<T>(
    url: string,
    init: RequestInit,
    abortSignal: AbortSignal | undefined,
    readResponse: (response: Response) => AsyncGenerator<StreamEvent, T, undefined>,
  ): AsyncGenerator<StreamEvent, T, undefined> {
    let lastError: ProviderError | undefined;
    let lastStatus: number | null = null;
    let lastReason = '';
    // Wait chosen from the failed response (its Retry-After, else backoff).
    let nextDelayMs: number | undefined;
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

      abortSignal?.throwIfAborted();
      try {
        const response = await fetch(url, { ...init, signal: abortSignal });
        if (response.ok) {
          responseStarted = true;
          return yield* readResponse(response);
        }

        let errorBody: string;
        try {
          errorBody = await response.text();
        } catch (err) {
          if (isAbortError(err, abortSignal)) throw err;
          errorBody = '';
          log.warn('HTTP error body unavailable', { status: response.status, reason: describeFetchError(err) });
        }
        const retryDelayMs = httpRetryDelay(DEFAULT_RETRY, attempt, response.status, response.headers);
        const error = this.createHttpError(response.status, errorBody, { retryable: retryDelayMs !== null, requestRejected: !responseStarted });
        if (!error.retryable) throw error;
        lastError = error;
        lastStatus = response.status;
        lastReason = apiErrorMessage(errorBody) ?? error.message;
        nextDelayMs = retryDelayMs!;
      } catch (err) {
        if (isAbortError(err, abortSignal)) throw err;
        if (err instanceof ProviderError && !err.retryable) throw err;
        lastReason = describeFetchError(err);
        lastError = err instanceof ProviderError ? err : new ProviderError(lastReason, {
          retryable: true,
          provider: this.name,
        });
        lastStatus = lastError.statusCode ?? null;
      }
    }

    throw withRetriesExhausted(lastError ?? new Error('Max retries exceeded'));
  }

  /** Create a descriptive error from an HTTP error response. */
  private createHttpError(
    status: number,
    body: string,
    options?: { retryable?: boolean; retriesExhausted?: boolean; requestRejected?: boolean },
  ): ProviderError {
    return ProviderError.fromHttpResponse(this.name, status, body, options);
  }
}
