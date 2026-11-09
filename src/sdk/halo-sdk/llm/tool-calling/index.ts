/**
 * @module llm/tool-calling
 * Public API for the multi-format tool calling adapter.
 * @license MIT
 */

export { PromptToolCallingAdapter } from './prompt-adapter.js';
export { resolveToolCallingMode, detectModelFamily } from './mode-detection.js';
export { renderToolsBlock } from './xml-renderer.js';
export { renderJsonToolsBlock } from './json-renderer.js';
export { parseXmlToolCalls } from './xml-parser.js';
export { parseJsonToolCalls } from './json-parser.js';
export { convertMessagesToText, injectToolsIntoSystemPrompt } from './message-adapter.js';
export type {
  ToolCallingMode,
  ModelFamily,
  ModelAdapter,
  ParseResult,
  ParsedToolCall,
} from './types.js';
