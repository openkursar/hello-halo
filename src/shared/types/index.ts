/**
 * Shared Types - Cross-process type definitions
 *
 * This module exports all shared types used by both main and renderer processes.
 * Import from this index for clean access to all shared types.
 */

// AI Sources types - export all types
export type {
  AuthType,
  BuiltinProviderId,
  ProviderId,
  LoginStatus,
  ApiProvider,
  ModelOption,
  AISourceUser,
  AISource,
  AISourcesConfig,
  OAuthSourceConfig,
  CustomSourceConfig,
  LegacyAISourcesConfig,
  BackendRequestConfig,
  DirectCallEndpoint,
  OAuthLoginState,
  OAuthStartResult,
  OAuthCompleteResult,
  AISourceType,
  AISourceUserInfo,
  LocalizedText,
  PresetApiConfig,
  AuthProviderConfig,
  ProviderDocsLink,
  AuthQuotaSnapshot
} from './ai-sources'

// AI Sources - export constants and functions
export {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  resolveModelId,
  createEmptyAISourcesConfig,
  getCurrentSource,
  getSourceById,
  getCurrentModelName,
  hasAnyAISource,
  isSourceConfigured,
  createSource,
  addSource,
  updateSource,
  deleteSource,
  setCurrentSource,
  setCurrentModel,
  getAvailableModels,
  resolveLocalizedText
} from './ai-sources'

// Health System types
export * from './health'

// Artifact types (shared between main process and file-watcher worker)
export * from './artifact'

// Notification channel types (shared between main process and renderer)
export * from './notification-channels'

// In-app toast contract (main -> renderer, incl. remote/mobile over WebSocket)
export * from './notification'

// Announcement feed contract (remote JSON -> main)
export * from './announcement'

// Inbound message types (IM channel adapter boundary types)
export * from './inbound-message'

// IM channel types (proactive push adapter + session records)
export * from './im-channel'

// Tlon knowledge base types (cross-process)
export * from './tlon'

// Agent definition types (for custom subagent configurations)
export type { AgentDefinition, AgentMcpServerSpec, PermissionMode, McpServerConfigForProcessTransport } from './agent-definition'

// File changes types (shared between main process agent and renderer diff)
export type { FileChangesSummary, ThoughtLike } from '../file-changes'
export { countChangedLines, calculateDiffStats, extractFileChangesSummaryFromThoughts } from '../file-changes'
