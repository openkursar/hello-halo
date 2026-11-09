/**
 * @module types/tool
 * Tool interface, ToolResult, ToolContext, and related types.
 * @license MIT
 */

import type { CostTracker } from '../core/cost.js';
import type { AgentConventions } from '../core/conventions.js';
import type { BackgroundTaskRegistry } from '../tools/bash/index.js';
import type { SkillCatalog } from '../skills/index.js';

// ---------------------------------------------------------------------------
// PermissionLevel
// ---------------------------------------------------------------------------

/** Permission level required by a tool. */
export type PermissionLevel =
  | 'none'       // Read-only, purely informational
  | 'readonly'   // Read-only access to filesystem or network
  | 'write'      // Write access to filesystem
  | 'execute';   // Arbitrary command execution

// ---------------------------------------------------------------------------
// ToolResult
// ---------------------------------------------------------------------------

/**
 * Image attached to a tool result, delivered to the model as an image content
 * block instead of text. `data` is raw base64 (no data: prefix).
 */
export interface ToolResultImage {
  mimeType: string;
  data: string;
}

/** The result of executing a tool. */
export interface ToolResult {
  /** Content to send back to the model as the tool result */
  content: string;
  /** Whether this invocation was an error */
  isError: boolean;
  /**
   * Images to deliver alongside the text as structured tool_result content.
   * Providers without image input degrade to the text placeholder only.
   */
  images?: ToolResultImage[];
  /** Optional structured metadata */
  metadata?: Record<string, unknown>;
}

/** Create a successful ToolResult. */
export function toolSuccess(
  content: string,
  metadata?: Record<string, unknown>,
  images?: ToolResultImage[],
): ToolResult {
  return { content, isError: false, metadata, ...(images ? { images } : {}) };
}

/** Create an error ToolResult. */
export function toolError(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: true, metadata };
}

// ---------------------------------------------------------------------------
// ShellState
// ---------------------------------------------------------------------------

/**
 * Persistent shell state shared across Bash tool invocations within one session.
 * Tracks cwd and env variables so `cd` and `export` persist across tool calls.
 */
export interface ShellState {
  /** Current working directory as tracked by the shell state */
  cwd: string;
  /** Environment variable overrides exported by previous commands */
  envVars: Map<string, string>;
}

// ---------------------------------------------------------------------------
// FileReadState
// ---------------------------------------------------------------------------

/**
 * Per-file state tracked by the Read tool and consumed by Write/Edit to enforce
 * "read-before-write" semantics.
 */
export interface FileReadState {
  /** Optional bounded copy of the content shown to the model. */
  content?: string;
  /** SHA-256 of the entire file's raw bytes when the read was recorded. */
  contentHash?: string;
  /** Full-precision mtime in milliseconds when the read was recorded. */
  timestamp: number;
  /** 1-based starting line if the caller requested a partial read; undefined when omitted. */
  offset?: number;
  /** Max line count if the caller requested a partial read; undefined when omitted. */
  limit?: number;
  /**
   * True when the model only saw a slice of the file (because offset/limit
   * truncated, the full read was capped, or it was injected as a partial
   * preview). Partial reads allow Edit but never authorize whole-file Write;
   * an Edit preserves that restriction. Only full reads allow an unchanged
   * content hash to satisfy a freshness check after mtime changes.
   */
  isPartialView?: boolean;
}

// ---------------------------------------------------------------------------
// ToolServices
// ---------------------------------------------------------------------------

/** Session-owned services supplied to tools; collaboration is a host capability. */
export interface ToolServices {
  /** Owns background shell tasks for this session. */
  backgroundTasks?: BackgroundTaskRegistry;
}

// ---------------------------------------------------------------------------
// ToolContext
// ---------------------------------------------------------------------------

/**
 * Shared context passed to every tool invocation.
 * Provides access to session state, filesystem, cost tracking, etc.
 */
export interface ToolContext {
  /** Unique session identifier */
  sessionId: string;
  /** Current working directory for this session */
  cwd: string;
  /** Abort signal for cancellation */
  abortSignal: AbortSignal;
  /** Cost tracker for budget enforcement */
  costTracker: CostTracker;
  /** Optional MCP manager for MCP tools */
  mcpManager?: unknown;
  /**
   * Read-before-write state map keyed by absolute (resolved) file path.
   * Populated by ReadTool, consumed by WriteTool/EditTool to enforce
   * read-before-write and stale-write detection (see FileReadState above).
   * The query loop always provides it, for the lifetime of one session; tests
   * may omit it to opt out of the check.
   */
  readFileState?: Map<string, FileReadState>;
  /** Session-owned background shell services. */
  services?: ToolServices;
  /** Current turn index in the query loop */
  currentTurn: number;
  /** Environment variables for this session */
  env: Record<string, string | undefined>;
  /**
   * Resolved filesystem/env conventions for this session.
   * Absent in minimal test contexts — readers fall back to the defaults.
   */
  conventions?: AgentConventions;
  /** The same skill sources used by this session's catalog and slash commands. */
  skillCatalog?: SkillCatalog;
  /** Additional directories the agent can access beyond cwd */
  additionalDirectories?: string[];
  /**
   * Paths the session's `Read(...)` rules close (utils/read-deny). Read refuses
   * them; Glob and Grep skip them while walking. Absent or empty: nothing closed.
   */
  readDenyRoots?: readonly string[];
  /**
   * Record a file's before/after content so the host can offer undo/rewind.
   * Wired by the composition layer; absent when the host does not track edits.
   */
  recordFileChange?: (path: string, beforeContent: Buffer, afterContent: Buffer) => void;
  /**
   * The tool_use ID for this specific invocation.
   * Set by the query loop to correlate tool-owned progress and messages.
   */
  toolUseId?: string;
  /**
   * Forward a tool-owned SDK message to the session stream.
   * Producers await the returned promise to respect consumer backpressure.
   * Uses Record<string,unknown> to avoid circular import with query-loop.
   */
  onToolMessage?: (msg: Record<string, unknown>) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool interface
// ---------------------------------------------------------------------------

/**
 * The interface every tool must implement.
 * Tools are capabilities the LLM can invoke during the ReAct loop.
 */
export interface Tool {
  /** Original MCP identity and capability text, assigned by the MCP bridge. */
  readonly mcpSource?: {
    readonly server: string;
    readonly name: string;
    readonly description?: string;
    readonly instructions?: string;
    readonly toolDescription?: string;
  };
  /** Human-readable tool name */
  readonly name: string;
  /**
   * Description shown to the LLM.
   * Carefully engineered prompt — do not modify without testing LLM behavior.
   */
  readonly description: string;
  /** JSON Schema describing the tool's input parameters */
  readonly inputSchema: Record<string, unknown>;
  /** Permission level required by this tool */
  readonly permissionLevel: PermissionLevel;
  /**
   * If true, this tool requires synchronous user interaction (e.g. answering
   * a multiple-choice question) and the host's `canUseTool` callback MUST be
   * invoked even when `permissionMode === 'bypassPermissions'` or the tool
   * appears in `allowedTools`. Without this flag, interactive tools like
   * AskUserQuestion would be silently auto-allowed and execute without ever
   * surfacing UI to the user.
   */
  readonly requiresUserInteraction?: boolean;
  /**
   * Whether this particular call may run at the same time as the other tool
   * calls the model asked for in the same turn.
   *
   * Judged per call rather than per tool, because the same tool can be safe or
   * unsafe depending on its input. Omit it and the call runs on its own: a tool
   * that mutates shared state — the working directory, a file, a counter — and
   * says nothing would otherwise corrupt it silently, which is a worse failure
   * than being slow.
   */
  readonly isConcurrencySafe?: (input: Record<string, unknown>) => boolean;
  /** Execute the tool with the given input */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// ToolDefinition (for LLM API)
// ---------------------------------------------------------------------------

/** Tool definition suitable for sending to the LLM API. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Convert a Tool to a ToolDefinition for the LLM API. */
export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}
