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
  AISourceUserInfo
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
  getAvailableModels
} from './ai-sources'

// Health System types
export * from './health'

// Artifact types (shared between main process and file-watcher worker)
export * from './artifact'

// File changes types (shared between main process agent and renderer diff)
export type { FileChangesSummary, ThoughtLike } from '../file-changes'
export { countChangedLines, calculateDiffStats, extractFileChangesSummaryFromThoughts } from '../file-changes'
