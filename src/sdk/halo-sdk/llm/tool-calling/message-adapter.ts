/**
 * @module llm/tool-calling/message-adapter
 * Bidirectional conversion between canonical Anthropic message format
 * (ContentBlock[]) and plain-text format used in xml / json prompt mode.
 *
 * Used by PromptToolCallingAdapter to transform messages before sending
 * to the inner provider and to inject tool descriptions into the system prompt.
 * @license MIT
 */

import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  SystemPrompt,
  SystemPromptBlock,
  ToolDefinition,
} from '../../types/provider.js';

// ---------------------------------------------------------------------------
// injectToolsIntoSystemPrompt
// ---------------------------------------------------------------------------

/**
 * Append a tool-description block to the system prompt.
 *
 * Handles all three forms of SystemPrompt:
 *   - string         → append with double newline separator
 *   - SystemPromptBlock[] → push a new text block
 *   - undefined      → return the tools block as a plain string
 */
export function injectToolsIntoSystemPrompt(
  systemPrompt: SystemPrompt | undefined,
  toolsBlock: string,
): SystemPrompt {
  if (!toolsBlock) return systemPrompt ?? '';

  if (systemPrompt === undefined) {
    return toolsBlock;
  }

  if (typeof systemPrompt === 'string') {
    return systemPrompt ? `${systemPrompt}\n\n${toolsBlock}` : toolsBlock;
  }

  // SystemPromptBlock[]
  const blocks: SystemPromptBlock[] = [...systemPrompt];
  blocks.push({ type: 'text', text: toolsBlock });
  return blocks;
}

// ---------------------------------------------------------------------------
// convertMessagesToText
// ---------------------------------------------------------------------------

/**
 * Convert a message history from canonical Anthropic format to plain-text
 * format for xml / json prompt mode.
 *
 * - ToolUseBlocks in assistant messages → XML invocation text
 * - ToolResultBlocks in user messages → [Tool Result/Error: name] text
 * - ThinkingBlocks, TextBlocks, and isMeta messages → passed through
 *
 * @param messages - Canonical message history.
 * @param _tools   - Tool definitions (unused now; reserved for future schema validation).
 * @returns New message array safe to send to the inner provider without FC.
 */
export function convertMessagesToText(
  messages: Message[],
  _tools?: ToolDefinition[],
): Message[] {
  // We need a two-pass approach:
  //   Pass 1: build a tool_use_id → tool_name lookup from assistant messages.
  //   Pass 2: convert each message.

  const toolIdToName = buildToolIdNameMap(messages);

  return messages.map((msg) => convertMessage(msg, toolIdToName));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a map from tool_use_id → tool name by scanning all assistant messages.
 */
function buildToolIdNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        map.set((block as ToolUseBlock).id, (block as ToolUseBlock).name);
      }
    }
  }
  return map;
}

/**
 * Convert a single message to plain-text format.
 * Messages whose content is already a string are returned unchanged.
 * isMeta messages with non-standard content structures are handled gracefully.
 */
function convertMessage(msg: Message, toolIdToName: Map<string, string>): Message {
  // String-content messages are already plain text — no conversion needed.
  if (typeof msg.content === 'string') {
    return msg;
  }

  const blocks = msg.content as ContentBlock[];

  if (msg.role === 'assistant') {
    return convertAssistantMessage(msg, blocks);
  }

  if (msg.role === 'user') {
    return convertUserMessage(msg, blocks, toolIdToName);
  }

  return msg;
}

/**
 * Convert an assistant message — serialize ToolUseBlocks to XML, keep text.
 */
function convertAssistantMessage(msg: Message, blocks: ContentBlock[]): Message {
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) parts.push(block.text);
    } else if (block.type === 'thinking') {
      // Preserve thinking content as-is (already processed by query-loop)
      if (block.thinking) parts.push(block.thinking);
    } else if (block.type === 'tool_use') {
      const toolBlock = block as ToolUseBlock;
      parts.push(serializeToolUse(toolBlock));
    }
    // Other block types (image, document, signature) are skipped —
    // they are Anthropic-specific and not relevant in xml / json mode.
  }

  return { ...msg, content: parts.join('\n\n') };
}

/**
 * Convert a user message — serialize ToolResultBlocks to text, keep other content.
 */
function convertUserMessage(
  msg: Message,
  blocks: ContentBlock[],
  toolIdToName: Map<string, string>,
): Message {
  const parts: string[] = [];
  const images: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) parts.push(block.text);
    } else if (block.type === 'tool_result') {
      const resultBlock = block as ToolResultBlock;
      const toolName = toolIdToName.get(resultBlock.tool_use_id) ?? resultBlock.tool_use_id;
      parts.push(serializeToolResult(resultBlock, toolName));
      if (Array.isArray(resultBlock.content)) {
        images.push(...resultBlock.content.filter((item) => item.type === 'image'));
      }
    } else if (block.type === 'image') {
      images.push(block);
    }
  }

  const text = parts.join('\n\n');
  return {
    ...msg,
    content: images.length > 0
      ? [...(text ? [{ type: 'text' as const, text }] : []), ...images]
      : text,
  };
}

/**
 * Serialize a ToolUseBlock to BFCL-style XML invocation text.
 *
 * Example output (BFCL format):
 * ```
 * <Bash>
 * <param name="command" type="string" required="true">ls -la</param>
 * </Bash>
 * ```
 *
 * We use BFCL format instead of legacy `<key>value</key>` because it
 * matches the Usage blocks in xml-renderer.ts, ensuring consistency
 * between newly-generated calls and historical calls in multi-turn
 * conversations.
 */
function serializeToolUse(block: ToolUseBlock): string {
  const lines: string[] = [`<${block.name}>`];

  for (const [key, value] of Object.entries(block.input)) {
    const serialized = serializeParamValue(value);
    lines.push(`<param name="${key}">${serialized}</param>`);
  }

  lines.push(`</${block.name}>`);
  return lines.join('\n');
}

/**
 * Serialize a parameter value to its string representation for XML embedding.
 *
 * - string   → as-is
 * - number / boolean → toString()
 * - object / array   → JSON.stringify with 2-space indent
 * - null / undefined → empty string
 */
function serializeParamValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

/**
 * Serialize a ToolResultBlock to plain-text representation.
 *
 * Success:
 * ```
 * [Tool Result: Bash]
 * output text here
 * ```
 *
 * Error:
 * ```
 * [Tool Error: Bash]
 * error message here
 * ```
 */
function serializeToolResult(block: ToolResultBlock, toolName: string): string {
  const header = block.is_error
    ? `[Tool Error: ${toolName}]`
    : `[Tool Result: ${toolName}]`;

  let body: string;
  if (typeof block.content === 'string') {
    body = block.content;
  } else if (Array.isArray(block.content)) {
    // Preserve text in the serialized tool result; images are forwarded as separate blocks.
    body = (block.content as ContentBlock[])
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');
  } else {
    body = '';
  }

  return `${header}\n${body}`;
}
