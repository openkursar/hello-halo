/**
 * @module llm/tool-calling/prompt-adapter
 * PromptToolCallingAdapter — wraps any LlmProvider to add prompt-injected tool calling.
 *
 * The adapter implements the LlmProvider interface, so it is transparent to the
 * query-loop. It:
 *   1. Strips tool definitions from the outgoing request.
 *   2. Injects tool descriptions into the system prompt.
 *   3. Converts prior tool_use / tool_result blocks to plain text.
 *   4. Parses the model's response with dual-format parsing — both JSON and XML
 *      formats are tried, and the result with more populated parameters wins.
 *      The losing format's artifacts are stripped from display text.
 *   5. Sets stopReason = 'tool_use' when tool calls are present.
 *
 * TODO: Incremental XML stream parsing — emit tool_use blocks as
 *                    soon as the closing tag is detected in the stream.
 * @license MIT
 */

import { randomUUID } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';
import type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderCapabilities,
  StreamEvent,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolDefinition,
} from '../../types/provider.js';
import type { ToolCallingMode, ParseResult, ParsedToolCall } from './types.js';
import { renderToolsBlock } from './xml-renderer.js';
import { renderJsonToolsBlock } from './json-renderer.js';
import { parseXmlToolCalls } from './xml-parser.js';
import { parseJsonToolCalls } from './json-parser.js';
import {
  convertMessagesToText,
  injectToolsIntoSystemPrompt,
} from './message-adapter.js';

// ---------------------------------------------------------------------------
// PromptToolCallingAdapter
// ---------------------------------------------------------------------------

const log = getLogger('PromptAdapter');

/**
 * An LlmProvider adapter that replaces native function-calling with
 * prompt-injected XML tool calling. Wraps any inner LlmProvider.
 */
export class PromptToolCallingAdapter implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly listModels?: LlmProvider['listModels'];
  readonly healthCheck?: LlmProvider['healthCheck'];

  private readonly mode: ToolCallingMode;

  constructor(
    private readonly inner: LlmProvider,
    mode: ToolCallingMode,
  ) {
    this.mode = mode;
    this.id = `${inner.id}:${mode}`;
    this.name = `${inner.name} (${mode})`;

    // Delegate optional methods to inner provider when available
    if (inner.listModels) {
      this.listModels = inner.listModels.bind(inner);
    }
    if (inner.healthCheck) {
      this.healthCheck = inner.healthCheck.bind(inner);
    }
  }

  // ---------------------------------------------------------------------------
  // capabilities
  // ---------------------------------------------------------------------------

  capabilities(): ProviderCapabilities {
    return {
      ...this.inner.capabilities(),
      toolCalling: true,
    };
  }

  // ---------------------------------------------------------------------------
  // createMessage
  // ---------------------------------------------------------------------------

  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    // Pass-through when no tools are defined
    if (!request.tools || request.tools.length === 0) {
      return this.inner.createMessage(request);
    }

    log.debug('prompt-adapter: createMessage', { model: request.model, mode: this.mode, tools: request.tools.length });
    const adaptedRequest = this.buildAdaptedRequest(request);
    const response = await this.inner.createMessage(adaptedRequest);

    return this.adaptResponse(response, request.tools);
  }

  // ---------------------------------------------------------------------------
  // createMessageStream
  // ---------------------------------------------------------------------------

  async *createMessageStream(
    request: ProviderRequest,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    // Pass-through when no tools are defined
    if (!request.tools || request.tools.length === 0) {
      yield* this.inner.createMessageStream(request);
      return;
    }

    log.debug('prompt-adapter: stream', { model: request.model, mode: this.mode, tools: request.tools.length });
    const adaptedRequest = this.buildAdaptedRequest(request);
    const tools = request.tools;

    // Accumulate the full text from the stream, then parse at message_stop.
    // TODO: Incremental XML stream parsing for lower latency.
    let textBuffer = '';
    let textBlockIndex = -1;

    // Deferred events that we hold until we've decided what to emit for the
    // text content_block_stop and message_delta.
    let deferredTextBlockStop: StreamEvent | null = null;
    let deferredMessageDelta: Extract<StreamEvent, { type: 'message_delta' }> | null = null;

    for await (const event of this.inner.createMessageStream(adaptedRequest)) {
      switch (event.type) {
        case 'message_start':
        case 'thinking_delta':
        case 'reasoning_delta':
        case 'input_json_delta':
        case 'signature_delta':
          yield event;
          break;

        case 'content_block_start': {
          // Track the index of the text block so we can defer its stop event.
          if (event.content_block.type === 'text') {
            textBlockIndex = event.index;
          }
          yield event;
          break;
        }

        case 'text_delta': {
          textBuffer += event.text;
          yield event;
          break;
        }

        case 'content_block_stop': {
          if (event.index === textBlockIndex) {
            // Defer — we'll emit after parsing decides whether to add tool blocks.
            deferredTextBlockStop = event;
          } else {
            yield event;
          }
          break;
        }

        case 'message_delta': {
          // Defer — we may need to change stopReason to 'tool_use'.
          deferredMessageDelta ??= { type: 'message_delta' };
          if (event.stopReason !== undefined) deferredMessageDelta.stopReason = event.stopReason;
          if (event.usage) {
            deferredMessageDelta.usage = { ...deferredMessageDelta.usage, ...event.usage };
          }
          break;
        }

        case 'message_stop': {
          // --- Dual-format parsing: try both JSON and XML, pick the best ---
          const toolNames = tools.map((t) => t.name);
          const { toolCalls, textContent, unreadable } = this.parseDualTools(textBuffer, toolNames);

          if (toolCalls.length > 0) {
            log.debug('prompt-adapter: parsed tool calls from stream', { count: toolCalls.length, mode: this.mode });
          } else {
            log.debug('prompt-adapter: no tool calls in stream');
          }

          // Emit the deferred text block stop with cleaned text (dual-parse
          // strips losing-format artifacts from textContent).
          if (deferredTextBlockStop) {
            yield deferredTextBlockStop;
          }
          // Replace the accumulated text buffer with the cleaned version so
          // consuming renderers that re-read the text block see the cleaned content.
          textBuffer = textContent;

          // If we found tool calls, emit tool_use content blocks
          if (toolCalls.length > 0) {
            let nextIndex = (textBlockIndex >= 0 ? textBlockIndex : -1) + 1;
            for (const call of toolCalls) {
              const toolUseBlock: ToolUseBlock = {
                type: 'tool_use',
                id: generateToolUseId(),
                name: call.name,
                input: call.parameters,
              };
              yield {
                type: 'content_block_start',
                index: nextIndex,
                content_block: toolUseBlock,
              } as StreamEvent;
              yield { type: 'content_block_stop', index: nextIndex } as StreamEvent;
              nextIndex++;
            }

            // Emit message_delta with updated stopReason
            if (deferredMessageDelta) {
              yield {
                ...deferredMessageDelta,
                stopReason: 'tool_use',
              } as StreamEvent;
            } else {
              yield { type: 'message_delta', stopReason: 'tool_use' } as StreamEvent;
            }
          } else {
            // No tool calls — emit original message_delta unchanged
            if (deferredMessageDelta) {
              yield deferredMessageDelta;
            }
          }

          // Always emit message_stop last, carrying the reason when the model's
          // attempt to call a tool could not be read.
          yield unreadable ? { type: 'message_stop', unreadableToolCall: unreadable } : event;
          break;
        }

        case 'error':
          yield event;
          break;

        case 'retry':
          // The failed attempt's text is void; parse only what the next one sends.
          textBuffer = '';
          textBlockIndex = -1;
          deferredTextBlockStop = null;
          deferredMessageDelta = null;
          yield event;
          break;

        default:
          yield event as StreamEvent;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Dual-format parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse tool calls from model text using both JSON and XML formats.
   *
   * When the model outputs tool calls in both formats (e.g. a correct JSON
   * fence alongside an empty XML tag), a single-format parser picks the wrong
   * one. This method runs both parsers, selects the result with more populated
   * parameters, and strips the losing format's artifacts from display text.
   */
  private parseDualTools(text: string, toolNames: string[]): ParseResult {
    const json = parseJsonToolCalls(text, toolNames);
    const xml = parseXmlToolCalls(text, toolNames);

    // No tool calls in either format. A reason from either parser survives:
    // it is the only evidence that the model meant to call something.
    if (!json.toolCalls.length && !xml.toolCalls.length) {
      const unreadable = json.unreadable ?? xml.unreadable;
      return { textContent: text, toolCalls: [], ...(unreadable ? { unreadable } : {}) };
    }

    // Only one format has results
    if (json.toolCalls.length && !xml.toolCalls.length) return json;
    if (xml.toolCalls.length && !json.toolCalls.length) return xml;

    // Both have results — pick the one with more populated params
    const jsonScore = scoreToolCallParams(json.toolCalls);
    const xmlScore = scoreToolCallParams(xml.toolCalls);

    log.debug('prompt-adapter: dual-parse both formats matched', {
      jsonScore,
      xmlScore,
      jsonCount: json.toolCalls.length,
      xmlCount: xml.toolCalls.length,
    });

    if (jsonScore >= xmlScore) {
      // JSON wins — strip any XML tool tags from prose
      return {
        ...json,
        textContent: stripXmlToolTags(json.textContent, toolNames),
      };
    }

    // XML wins — strip JSON code fences from prose
    return {
      ...xml,
      textContent: stripJsonFences(xml.textContent),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the adapted ProviderRequest:
   *   - Remove tools (no native FC)
   *   - Inject tool descriptions into system prompt
   *   - Convert message history to plain text
   */
  private buildAdaptedRequest(request: ProviderRequest): ProviderRequest {
    const tools = request.tools as ToolDefinition[];
    const toolsBlock = this.mode === 'json'
      ? renderJsonToolsBlock(tools)
      : renderToolsBlock(tools);
    const adaptedSystemPrompt = injectToolsIntoSystemPrompt(request.systemPrompt, toolsBlock);
    const adaptedMessages = convertMessagesToText(request.messages, tools);
    if (!this.inner.capabilities().imageInput && adaptedMessages.some((message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === 'image')
    )) {
      log.error('Prompt tool-calling cannot forward images to a provider without image input', { provider: this.inner.id });
      throw new Error(`Provider ${this.inner.id} cannot accept images from tool results; select an image-capable model`);
    }

    return {
      ...request,
      tools: undefined,
      systemPrompt: adaptedSystemPrompt,
      messages: adaptedMessages,
    };
  }

  /**
   * Adapt a complete ProviderResponse:
   *   - Parse XML tool calls from text content
   *   - Build ToolUseBlocks for found calls
   *   - Set stopReason = 'tool_use' when needed
   */
  private adaptResponse(
    response: ProviderResponse,
    tools: ToolDefinition[],
  ): ProviderResponse {
    // Collect all text from the response
    const fullText = response.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const toolNames = tools.map((t) => t.name);
    const { textContent, toolCalls } = this.parseDualTools(fullText, toolNames);

    if (toolCalls.length === 0) {
      log.debug('prompt-adapter: no tool calls in response');
      return response;
    }

    log.debug('prompt-adapter: parsed tool calls from response', { count: toolCalls.length, mode: this.mode });

    // Build new content array: text before tool calls + ToolUseBlocks
    const newContent: ContentBlock[] = [];

    // Preserve non-text blocks (thinking blocks etc.) that were before the tool call
    for (const block of response.content) {
      if (block.type !== 'text') {
        newContent.push(block);
      }
    }

    // Add the text preceding the first tool call
    newContent.push({ type: 'text', text: textContent } as TextBlock);

    // Add tool use blocks
    for (const call of toolCalls) {
      newContent.push({
        type: 'tool_use',
        id: generateToolUseId(),
        name: call.name,
        input: call.parameters,
      } as ToolUseBlock);
    }

    return {
      ...response,
      content: newContent,
      stopReason: 'tool_use',
    };
  }
}

// ---------------------------------------------------------------------------
// Dual-parse helpers
// ---------------------------------------------------------------------------

/**
 * Score a set of parsed tool calls by parameter "fullness".
 *
 * Each non-null, non-undefined, non-empty-string parameter value counts as 1.
 * Models sometimes emit tool tags / JSON entries with empty or partially
 * populated parameters — the format with more actual data is preferred.
 */
function scoreToolCallParams(toolCalls: ParsedToolCall[]): number {
  let score = 0;
  for (const call of toolCalls) {
    for (const value of Object.values(call.parameters)) {
      if (value !== null && value !== undefined && value !== '') {
        score += 1;
      }
    }
  }
  return score;
}

/**
 * Strip all ```json ... ``` code fence blocks from text.
 */
function stripJsonFences(text: string): string {
  return text.replace(/```json\s*[\s\S]*?\s*```/g, '').trimEnd();
}

/**
 * Strip tool-call XML tags (only known tool names) from text.
 * Unknown XML tags are left untouched.
 */
function stripXmlToolTags(text: string, toolNames: string[]): string {
  if (toolNames.length === 0) return text;
  const escapedNames = toolNames.map(escapeRegexMeta).join('|');
  const toolRegex = new RegExp(`<(${escapedNames})>\\s*<\\/\\1>`, 'g');
  return text.replace(toolRegex, '').trimEnd();
}

/** Escape special regex characters in a string. */
function escapeRegexMeta(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a tool_use_id in the `toolu_` format used by Anthropic.
 * Uses crypto.randomUUID() for uniqueness.
 */
function generateToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
