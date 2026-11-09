/**
 * @module llm/tool-calling/types
 * Types for the multi-format tool calling adapter.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// ToolCallingMode
// ---------------------------------------------------------------------------

/**
 * Tool calling protocol mode.
 *
 * - `'native'` — Use the provider's native function-calling API.
 *                Preferred for models with native function calling.
 * - `'xml'`    — Prompt-injected BFCL-style XML tool calling. Tool descriptions
 *                are injected into the system prompt as BFCL XML; the model
 *                emits `<tool><param name="p">v</param></tool>` tags which the
 *                SDK parses into ToolUseBlocks.
 *                Preferred for DeepSeek / Qwen / Kimi / MiniMax and
 *                any model where native FC quality is poor.
 * - `'json'`   — Prompt-injected JSON code-fence tool calling. Tool descriptions
 *                are rendered as markdown with JSON usage examples; the model
 *                emits ` ```json [... ] ``` ` blocks.
 *                Preferred for GLM and models that excel at JSON output.
 */
export type ToolCallingMode = 'native' | 'xml' | 'json';

// ---------------------------------------------------------------------------
// ModelFamily
// ---------------------------------------------------------------------------

/** Recognized model family identifiers. */
export type ModelFamily =
  | 'anthropic'   // Claude series
  | 'openai'      // GPT / o-series
  | 'google'      // Gemini
  | 'deepseek'    // DeepSeek series
  | 'qwen'        // Alibaba Qwen series
  | 'glm'         // Zhipu GLM series
  | 'kimi'        // Moonshot Kimi series
  | 'minimax'     // MiniMax series
  | 'unknown'     // Unrecognized model
  | string;       // Extension point

// ---------------------------------------------------------------------------
// ModelAdapter — reserved interface
// ---------------------------------------------------------------------------

/**
 * Reserved consumer adapter shape. The SDK does not invoke these callbacks;
 * generated system wording is selected separately through promptProfile.
 */
export interface ModelAdapter {
  /** Family this adapter handles. */
  readonly family: ModelFamily;
  /** Default tool calling mode for this family. */
  readonly preferredToolCallingMode: ToolCallingMode;
  /**
   * Optional description transformation for consumers implementing this shape.
   */
  adaptToolDescription?(description: string): string;
  /**
   * Optional prompt transformation for consumers implementing this shape.
   */
  adaptSystemPrompt?(prompt: string): string;
  /** Request parameter defaults for this family. */
  requestDefaults?: {
    temperature?: number;
    topP?: number;
  };
}

// ---------------------------------------------------------------------------
// ParsedToolCall / ParseResult — output of xml-parser
// ---------------------------------------------------------------------------

/** A single tool call parsed from XML. */
export interface ParsedToolCall {
  /** Tool name (matches ToolDefinition.name). */
  name: string;
  /** Parsed parameters. */
  parameters: Record<string, unknown>;
  /** Original XML text (for debugging). */
  rawXml: string;
}

/** Result of parseXmlToolCalls(). */
export interface ParseResult {
  /** Text appearing before the first tool call (the model's prose). */
  textContent: string;
  /** All tool calls found in the text, in order of appearance. */
  toolCalls: ParsedToolCall[];
  /**
   * Why a block that looked like a tool call could not be read.
   *
   * Set only when the model plainly meant to call something and the attempt
   * was unusable. Without it the call is dropped and the turn ends on prose,
   * leaving the model with no idea its request never ran.
   */
  unreadable?: string;
}
