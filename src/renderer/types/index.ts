// ============================================		      	    				  	  	  	 		 		       	 	 	         	 	    					 
// Halo Type Definitions
// ============================================

// Import values needed in this file's scope
import {
  AISourcesConfig,
  DEFAULT_MODEL,
  getCurrentModelName,
  hasAnyAISource
} from '../../shared/types/ai-sources';

// Re-export them
export { DEFAULT_MODEL, getCurrentModelName, hasAnyAISource };

// Re-export types from shared module (v2)
export type {
  AISource,
  AISourcesConfig,
  AISourceUser,
  AISourceType,
  AuthType,
  ProviderId,
  BuiltinProviderId,
  ModelOption,
  ApiProvider,
  BackendRequestConfig,
  LoginStatus,
  OAuthLoginState,
  OAuthStartResult,
  OAuthCompleteResult,
  // Legacy types for backward compatibility
  LegacyAISourcesConfig,
  OAuthSourceConfig,
  CustomSourceConfig
} from '../../shared/types/ai-sources';

// Re-export other values
export {
  AVAILABLE_MODELS,
  createEmptyAISourcesConfig,
  getCurrentSource,
  getSourceById,
  isSourceConfigured,
  createSource,
  addSource,
  updateSource,
  deleteSource,
  setCurrentSource,
  setCurrentModel,
  getAvailableModels
} from '../../shared/types/ai-sources';

// Re-export provider constants
export {
  BUILTIN_PROVIDERS,
  getBuiltinProvider,
  isBuiltinProvider,
  getRecommendedProviders,
  getProvidersByRegion,
  getApiKeyProviders,
  getProviderDisplayInfo,
  getDefaultModel,
  isOAuthProvider,
  isAnthropicProvider,
  getAllProviderIds,
  type BuiltinProvider
} from '../../shared/constants/providers';

// Permission Level
export type PermissionLevel = 'allow' | 'ask' | 'deny';

// Theme Mode
export type ThemeMode = 'light' | 'dark' | 'system';

// Tool Call Status
export type ToolStatus = 'pending' | 'running' | 'success' | 'error' | 'waiting_approval';

// Message Role
export type MessageRole = 'user' | 'assistant' | 'system';

// ============================================
// Configuration Types
// ============================================

// Legacy ApiConfig (for backward compatibility)
export interface ApiConfig {
  provider: ApiProvider;
  apiKey: string;
  apiUrl: string;
  model: string;
  availableModels?: string[];
}

export interface PermissionConfig {
  fileAccess: PermissionLevel;
  commandExecution: PermissionLevel;
  networkAccess: PermissionLevel;
  trustMode: boolean;
}

export interface AppearanceConfig {
  theme: ThemeMode;
}

// System configuration for auto-launch behavior
export interface SystemConfig {
  autoLaunch: boolean;      // Launch on system startup
}

// Remote access configuration
export interface RemoteAccessConfig {
  enabled: boolean;
  port: number;
}

// AI Sources types are now imported from shared module (see top of file)

// ============================================
// MCP Server Configuration Types
// Format compatible with Cursor / Claude Desktop
// ============================================

// MCP stdio server (command-based, most common)
export interface McpStdioServerConfig {
  type?: 'stdio';  // Optional, defaults to stdio
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;  // milliseconds
  disabled?: boolean;  // Halo extension: temporarily disable this server
}

// MCP HTTP server (REST API)
export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;  // Halo extension: temporarily disable this server
}

// MCP SSE server (Server-Sent Events)
export interface McpSseServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;  // Halo extension: temporarily disable this server
}

// Union type for all MCP server configs
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

// MCP servers map (key is server name)
export type McpServersConfig = Record<string, McpServerConfig>;

// MCP server status (from SDK)
export type McpServerStatusType = 'connected' | 'failed' | 'needs-auth' | 'pending';

export interface McpServerStatus {
  name: string;
  status: McpServerStatusType;
  serverInfo?: {
    name: string;
    version: string;
  };
  error?: string;
}

export interface NotificationConfig {
  taskComplete: boolean;  // System notification when a task completes
}

// Global layout preferences (panel sizes and visibility)
export interface LayoutConfig {
  sidebarOpen?: boolean;          // Whether conversation list sidebar is open
  sidebarWidth?: number;          // Conversation list sidebar width (px)
  artifactRailWidth?: number;     // Artifact rail panel width (px)
}

export interface HaloConfig {
  api: ApiConfig;  // Legacy, kept for backward compatibility
  aiSources: AISourcesConfig;  // v2 format: { version: 2, currentId, sources: [] }
  permissions: PermissionConfig;
  appearance: AppearanceConfig;
  system: SystemConfig;
  remoteAccess: RemoteAccessConfig;
  mcpServers: McpServersConfig;  // MCP servers configuration
  notifications?: NotificationConfig;  // Notification preferences
  layout?: LayoutConfig;  // Global layout preferences (panel sizes and visibility)
  isFirstLaunch: boolean;
}

// ============================================
// Space Types
// ============================================

// Layout preferences for a space (persisted to meta.json)
export interface SpaceLayoutPreferences {
  artifactRailExpanded?: boolean;  // Whether rail stays expanded when canvas is open
  chatWidth?: number;              // Custom chat panel width when canvas is open
}

// All space preferences (extensible for future features)
export interface SpacePreferences {
  layout?: SpaceLayoutPreferences;
}

export interface Space {
  id: string;
  name: string;
  icon: string;
  path: string;
  isTemp: boolean;
  createdAt: string;
  updatedAt: string;
  preferences?: SpacePreferences;  // User preferences for this space
  workingDir?: string;  // Project directory for custom spaces (agent cwd, artifacts, file explorer)
}

export interface CreateSpaceInput {
  name: string;
  icon: string;
  customPath?: string;
}

// ============================================
// Conversation Types
// ============================================

// Lightweight metadata for conversation list (no messages)
// Used by listConversations for fast loading
export interface ConversationMeta {
  id: string;
  spaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview?: string;  // Last message preview (truncated)
  starred?: boolean; // Pinned conversation for quick access
}

// ============================================
// Pulse Types (Task Status & Quick Navigation)
// ============================================

// Derived task status for a conversation
export type TaskStatus = 'generating' | 'waiting' | 'completed-unseen' | 'error' | 'idle';

// Item in the Pulse panel
export interface PulseItem {
  conversationId: string;
  spaceId: string;
  spaceName: string;
  title: string;
  status: TaskStatus;
  starred: boolean;
  updatedAt: string;
  /** Timestamp when user viewed this item; present = item is in grace period before removal */
  readAt?: number;
}

/** Grace period for read pulse items before removal (milliseconds) */
export const PULSE_READ_GRACE_PERIOD_MS = 60_000

// Full conversation with messages
// Loaded on-demand when selecting a conversation
export interface Conversation extends ConversationMeta {
  messages: Message[];
  sessionId?: string;
  version?: number;  // Format version: 2 = thoughts separated into .thoughts.json
}

// ============================================
// Message Types
// ============================================

export interface ToolCall {
  id: string;
  name: string;
  status: ToolStatus;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  progress?: number;
  requiresApproval?: boolean;
  description?: string;
}

// ============================================
// Image Attachment Types (for multi-modal messages)
// ============================================

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

// Image attachment for messages
export interface ImageAttachment {
  id: string;
  type: 'image';
  mediaType: ImageMediaType;
  data: string;  // Base64 encoded image data
  name?: string;  // Optional filename
  size?: number;  // File size in bytes
}

// Content block types for multi-modal messages (matches Claude API)
export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
}

export type MessageContentBlock = TextContentBlock | ImageContentBlock;

// Summary of thoughts for a message (used when thoughts are stored separately)
export interface ThoughtsSummary {
  count: number;
  types: Partial<Record<ThoughtType, number>>;
  duration?: number;  // seconds, from first to last thought timestamp
}

/**
 * Lightweight file changes summary stored in message metadata.
 * Allows immediate display of file change stats without loading full thoughts.
 */
export type { FileChangesSummary } from '../../shared/file-changes';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;  // Text content (for backward compatibility)
  timestamp: string;
  toolCalls?: ToolCall[];
  thoughts?: Thought[] | null;  // null = stored separately (not loaded), undefined = none, Array = loaded
  thoughtsSummary?: ThoughtsSummary;  // Present when thoughts are stored separately
  isStreaming?: boolean;
  images?: ImageAttachment[];  // Attached images
  tokenUsage?: TokenUsage;  // Token usage for this assistant message
  metadata?: {
    fileChanges?: FileChangesSummary;  // Lightweight file changes for immediate display
  };
  error?: string;  // Error message when assistant response failed (e.g., 429 rate limit)
}

// ============================================
// Artifact Types
// ============================================

export type ArtifactType = 'file' | 'folder';

export interface Artifact {
  id: string;
  spaceId: string;
  conversationId: string;
  name: string;
  type: ArtifactType;
  path: string;
  extension: string;
  icon: string;
  createdAt: string;
  preview?: string;
  size?: number;
}

// Tree node structure for developer view
// Mirrors CachedTreeNode from main process — no conversion needed across IPC
export interface ArtifactTreeNode {
  id: string;
  name: string;
  type: ArtifactType;
  path: string;
  relativePath: string;
  extension: string;
  icon: string;
  size?: number;
  depth: number;
  children?: ArtifactTreeNode[];
  childrenLoaded: boolean;
}

// Artifact change event from file watcher
export interface ArtifactChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  relativePath: string;
  spaceId: string;
  item?: Artifact | ArtifactTreeNode;
}

// Tree update event pushed from main process with pre-computed data
export interface ArtifactTreeUpdateEvent {
  spaceId: string;
  updatedDirs: Array<{ dirPath: string; children: ArtifactTreeNode[] }>;
  changes: ArtifactChangeEvent[];
}

// View mode for artifact display
export type ArtifactViewMode = 'card' | 'tree';

// ============================================
// Thought Process Types (Agent's real-time reasoning)
// ============================================

export type ThoughtType = 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error';

export interface Thought {
  id: string;
  type: ThoughtType;
  content: string;
  timestamp: string;
  // For tool-related thoughts
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  // For result thoughts
  duration?: number;
  // For streaming state (real-time updates)
  isStreaming?: boolean;  // True while content is being streamed
  isReady?: boolean;      // True when tool params are complete (for tool_use)
  // For merged tool result display (tool_use contains its result)
  toolResult?: {
    output: string;
    isError: boolean;
    timestamp: string;
  };
}

// Legacy alias for backwards compatibility
export interface ThinkingBlock {
  id: string;
  content: string;
  timestamp: string;
  isComplete: boolean;
}

// ============================================
// Canvas Context Types (AI awareness of user's open tabs)
// ============================================

/**
 * Canvas Context - Provides AI with awareness of user's currently open tabs
 * Injected into messages to enable natural language understanding of user context
 */
export interface CanvasContext {
  isOpen: boolean;
  tabCount: number;
  activeTab: {
    type: string;  // 'browser' | 'code' | 'markdown' | 'image' | 'pdf' | 'text' | 'json' | 'csv'
    title: string;
    url?: string;   // For browser/pdf tabs
    path?: string;  // For file tabs
  } | null;
  tabs: Array<{
    type: string;
    title: string;
    url?: string;
    path?: string;
    isActive: boolean;
  }>;
}

// ============================================
// Agent Event Types
// All events now include spaceId and conversationId for multi-session support
// ============================================

// Base event with session identifiers
export interface AgentEventBase {
  spaceId: string;
  conversationId: string;
}

export interface AgentMessageEvent extends AgentEventBase {
  type: 'message';
  content: string;
  isComplete: boolean;
  timestamp?: number;
}

export interface AgentThinkingEvent extends AgentEventBase {
  type: 'thinking';
  thinking: ThinkingBlock;
}

export interface AgentToolCallEvent extends AgentEventBase {
  type: 'tool_call';
  toolCall: ToolCall;
}

export interface AgentToolResultEvent extends AgentEventBase {
  type: 'tool_result';
  toolId: string;
  result: string;
  isError: boolean;
}

// Error type for special handling (e.g., interrupted response)
export type AgentErrorType = 'interrupted';

export interface AgentErrorEvent extends AgentEventBase {
  type: 'error';
  error: string;
  errorType?: AgentErrorType;  // Special error type for custom UI handling
}

// Token usage statistics from SDK result message
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  contextWindow: number;
}

export interface AgentCompleteEvent extends AgentEventBase {
  type: 'complete';
  duration: number;
  tokenUsage?: TokenUsage | null;
}

export interface AgentThoughtEvent extends AgentEventBase {
  thought: Thought;
}

// Compact notification info (context compression)
export interface CompactInfo {
  trigger: 'manual' | 'auto';
  preTokens: number;
}

// ============================================
// AskUserQuestion Types
// ============================================

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;        // Question text
  header: string;          // Short label chip (max 12 chars)
  options: QuestionOption[]; // 2-4 options
  multiSelect: boolean;    // Whether multiple selections allowed
}

export type AskQuestionStatus = 'active' | 'answered' | 'cancelled';

export interface PendingQuestion {
  id: string;                        // Unique ID (toolUseId or timestamp)
  questions: Question[];             // 1-4 questions
  status: AskQuestionStatus;
  answers?: Record<string, string>;  // User answers {"0": "JWT Tokens", "1": "PostgreSQL"}
}

export interface AgentCompactEvent extends AgentEventBase {
  type: 'compact';
  trigger: 'manual' | 'auto';
  preTokens: number;
}

export type AgentEvent =
  | AgentMessageEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentErrorEvent
  | AgentCompleteEvent
  | AgentCompactEvent;

// ============================================
// App State Types
// ============================================

export type AppView = 'splash' | 'gitBashSetup' | 'setup' | 'home' | 'space' | 'settings';

export interface AppState {
  view: AppView;
  isLoading: boolean;
  error: string | null;
  config: HaloConfig | null;
}

// ============================================
// IPC Types
// ============================================

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================
// Utility Types
// ============================================

export interface ValidationResult {
  valid: boolean;
  message?: string;
  model?: string;
}

// Default values
export const DEFAULT_CONFIG: HaloConfig = {
  api: {
    provider: 'anthropic',
    apiKey: '',
    apiUrl: 'https://api.anthropic.com',
    model: DEFAULT_MODEL
  },
  aiSources: {
    version: 2,
    currentId: null,
    sources: []
  },
  permissions: {
    fileAccess: 'allow',
    commandExecution: 'ask',
    networkAccess: 'allow',
    trustMode: false
  },
  appearance: {
    theme: 'system'
  },
  system: {
    autoLaunch: false
  },
  remoteAccess: {
    enabled: false,
    port: 3456
  },
  mcpServers: {},  // Empty by default
  isFirstLaunch: true
};

// Helper functions hasAnyAISource and getCurrentModelName are now imported from shared module

// Helper function wrapper for HaloConfig (uses v2 format)
export function hasAnyConfiguredSource(config: HaloConfig): boolean {
  return hasAnyAISource(config.aiSources);
}

// Helper function wrapper for HaloConfig (uses v2 format)
export function getConfigCurrentModelName(config: HaloConfig): string {
  return getCurrentModelName(config.aiSources);
}

// Icon options for spaces (using icon IDs that map to Lucide icons)
export const SPACE_ICONS = [
  'folder', 'code', 'globe', 'chart', 'file-text', 'palette',
  'gamepad', 'wrench', 'smartphone', 'lightbulb', 'rocket', 'star'
] as const;

export type SpaceIconId = typeof SPACE_ICONS[number];

// Default space icon
export const DEFAULT_SPACE_ICON: SpaceIconId = 'folder';

// File type to icon ID mapping (maps to Lucide icon names)
export const FILE_ICON_IDS: Record<string, string> = {
  html: 'globe',
  htm: 'globe',
  css: 'palette',
  scss: 'palette',
  less: 'palette',
  js: 'file-code',
  jsx: 'file-code',
  ts: 'file-code',
  tsx: 'file-code',
  json: 'file-json',
  md: 'book',
  markdown: 'book',
  txt: 'file-text',
  py: 'file-code',
  rs: 'cpu',
  go: 'file-code',
  java: 'coffee',
  cpp: 'cpu',
  c: 'cpu',
  h: 'cpu',
  hpp: 'cpu',
  rb: 'gem',
  swift: 'apple',
  sql: 'database',
  sh: 'terminal',
  bash: 'terminal',
  zsh: 'terminal',
  yaml: 'file-json',
  yml: 'file-json',
  xml: 'file-json',
  svg: 'image',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  pdf: 'book',
  doc: 'file-text',
  docx: 'file-text',
  xls: 'database',
  xlsx: 'database',
  zip: 'package',
  tar: 'package',
  gz: 'package',
  rar: 'package',
  default: 'file-text'
};

export function getFileIconId(extension: string): string {
  return FILE_ICON_IDS[extension.toLowerCase()] || FILE_ICON_IDS.default;
}
