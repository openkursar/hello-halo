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
  OAuthLoginState,
  OAuthStartResult,
  OAuthCompleteResult,
  AISourceType,
  AISourceUserInfo,
  LocalizedText,
  PresetApiConfig,
  AuthProviderConfig
} from './ai-sources'

// AI Sources - export constants and functions
export {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
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

// Inbound message types (IM channel adapter boundary types)
export * from './inbound-message'

// IM channel types (proactive push adapter + session records)
export * from './im-channel'

// Agent definition types (for custom subagent configurations)
export type { AgentDefinition, AgentMcpServerSpec, PermissionMode, McpServerConfigForProcessTransport } from './agent-definition'

// File changes types (shared between main process agent and renderer diff)
export type { FileChangesSummary, ThoughtLike } from '../file-changes'
export { countChangedLines, calculateDiffStats, extractFileChangesSummaryFromThoughts } from '../file-changes'
