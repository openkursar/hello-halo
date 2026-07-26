/**
 * API Routes - REST API endpoints for remote access
 * Mirrors the IPC API structure
 */

import { Express, Request, Response } from 'express'
import { app as electronApp } from 'electron'
import { createReadStream, statSync, existsSync, readdirSync, realpathSync } from 'fs'
import { join, basename, relative, resolve, isAbsolute } from 'path'
import { createGzip } from 'zlib'
import { Readable } from 'stream'

import * as agentController from '../../controllers/agent.controller'
import * as spaceController from '../../controllers/space.controller'
import * as conversationController from '../../controllers/conversation.controller'
import * as configController from '../../controllers/config.controller'
import { getEnabledAuthProviderConfigs, getAISourceManager } from '../../services/ai-sources'
import { testChannel, clearAllTokenCaches } from '../../services/notify-channels'
import type { NotificationChannelType } from '../../../shared/types/notification-channels'
import {
  listArtifacts,
  listArtifactsTree,
  loadTreeChildren,
  reconcileArtifacts,
  readArtifactContent,
  saveArtifactContent,
  detectFileType,
  createFile,
  createFolder,
  trashArtifact,
  renameArtifact,
  moveArtifact
} from '../../services/artifact.service'
import { getTempSpacePath, getSpacesDir, getConfig as getServiceConfig, saveConfig } from '../../foundation/config.service'
import { getSpace, getAllSpacePaths } from '../../services/space.service'
import { getAppManager } from '../../apps/manager'
import { AppAlreadyInstalledError, McpCommandBlockedError } from '../../apps/manager/errors'
import { getAppRuntime, getImChannelManager, sendAppChatMessage, stopAppChat, isAppChatGenerating, loadAppChatMessages, loadImChatMessages, getAppChatSessionState, getAppChatConversationId, clearAppChat, clearImSession, stopImSession, restartAppChat, dispatchInboundMessage } from '../../apps/runtime'
import { buildDefaultAssistantSpec } from '../../apps/runtime/im-channels/wecom-bot-default-spec'
import type { AppListFilter, UninstallOptions, InstalledApp } from '../../apps/manager'
import type { ActivityQueryOptions, EscalationResponse, AppChatRequest } from '../../apps/runtime'
import { readSessionMessages } from '../../apps/runtime/session-store'
import { getImSessionRegistry } from '../../apps/runtime/im-session-registry'
import { analytics } from '../../services/analytics/analytics.service'
import { broadcastToAll } from '../websocket'
import * as appController from '../../controllers/app.controller'
import type { AppErrorCode } from '../../controllers/app.controller'
import * as storeController from '../../controllers/store.controller'
import {
  rejectIfRemoteMcpForbidden,
  rejectIfRemoteMcpForbiddenAsync,
  rejectIfRemoteBrowserAllowlistForbidden,
  isMcpAppSpec,
  patchTouchesMcp,
  configTouchesMcp,
  yamlIsMcpSpec,
  getPublicSecurityPolicy,
  MCP_COMMAND_BLOCKED,
  MCP_COMMAND_BLOCKED_MESSAGE,
} from '../../services/security-policy'

/**
 * Shape the HTTP 403 returned when an MCP install is rejected by
 * `security.mcpCommandBlacklist`. The user-facing message is the generic
 * policy-text constant (avoids leaking which exact name was matched);
 * structured logging keeps the offending command for operators.
 */
export function writeMcpCommandBlockedResponse(
  res: Response,
  error: McpCommandBlockedError,
  surface: string,
): void {
  console.warn(`[SecurityPolicy] Blocked MCP install at ${surface} (command='${error.command}')`)
  res.status(403).json({
    success: false,
    error: MCP_COMMAND_BLOCKED_MESSAGE,
    code: MCP_COMMAND_BLOCKED,
  })
}

/**
 * Peek a store entry's spec type. Returns true when the resolved spec is
 * an MCP. Used to gate /api/store/install routes — only called when
 * remoteMcpSafe is on, so the (cached) network/disk lookup never runs in
 * default open-source builds.
 */
export async function storeSlugIsMcp(slug: string): Promise<boolean> {
  try {
    const detail = await storeController.getStoreAppDetail(slug)
    return detail.success && isMcpAppSpec(detail.data.spec)
  } catch {
    return false
  }
}
import { modelCapabilitiesService } from '../../services/model-capabilities.service'
import type { ModelCapabilityOverride } from '../../../shared/types/model-capabilities'
import { fetchJson, ILINK_BASE_URL } from '../../apps/runtime/im-channels/ilink-api'
import { saveIlinkToken, disconnectIlink } from '../../controllers/weixin-ilink.controller'
import {
  generateScode as wecomGenerateScode,
  pollResult as wecomPollResult,
  ScanAuthError as WecomScanAuthError,
} from '../../apps/runtime/im-channels/wecom-bot-scan-auth'

// Helper: get working directory for a space
export function getWorkingDir(spaceId: string): string {
  if (spaceId === 'halo-temp') {
    return join(getTempSpacePath(), 'artifacts')
  }
  const space = getSpace(spaceId)
  return space ? (space.workingDir || space.path) : getTempSpacePath()
}

// Helper: collect all files in a directory recursively for tar-like output
export function collectFiles(dir: string, baseDir: string, files: { path: string; fullPath: string }[] = []): { path: string; fullPath: string }[] {
  if (!existsSync(dir)) return files

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const fullPath = join(dir, entry.name)
    const relativePath = relative(baseDir, fullPath)

    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, files)
    } else {
      files.push({ path: relativePath, fullPath })
    }
  }
  return files
}

/**
 * Check if target path is inside base path.
 * Uses realpathSync to resolve symlinks and prevent symlink-based path traversal attacks.
 */
export function isPathInside(target: string, base: string): boolean {
  try {
    // Use realpathSync to resolve symlinks for security
    const realBase = realpathSync(base)
    const realTarget = realpathSync(target)
    const relativePath = relative(realBase, realTarget)
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  } catch {
    // If path doesn't exist or can't be resolved, deny access
    return false
  }
}

/**
 * Check if target path is allowed (inside any space directory).
 * Resolves symlinks to prevent directory traversal via symlinks.
 */
export function isPathAllowed(target: string): boolean {
  // First check if path exists
  if (!existsSync(target)) {
    return false
  }

  try {
    const realTarget = realpathSync(target)
    const allowedBases = getAllSpacePaths().filter(p => existsSync(p))
    return allowedBases.some(base => {
      try {
        const realBase = realpathSync(base)
        const relativePath = relative(realBase, realTarget)
        return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

export function validateFilePath(res: Response, filePath?: string): string | null {
  if (!filePath) {
    res.status(400).json({ success: false, error: 'Missing file path' })
    return null
  }

  if (!isPathAllowed(filePath)) {
    res.status(403).json({ success: false, error: 'Access denied' })
    return null
  }

  return resolve(filePath)
}

// ---- Re-exported dependencies for the per-domain route modules ----
export {
  AppAlreadyInstalledError,
  ILINK_BASE_URL,
  MCP_COMMAND_BLOCKED,
  MCP_COMMAND_BLOCKED_MESSAGE,
  McpCommandBlockedError,
  Readable,
  WecomScanAuthError,
  agentController,
  analytics,
  appController,
  basename,
  broadcastToAll,
  buildDefaultAssistantSpec,
  clearAllTokenCaches,
  clearAppChat,
  clearImSession,
  stopImSession,
  configController,
  configTouchesMcp,
  conversationController,
  createFile,
  createFolder,
  createGzip,
  createReadStream,
  detectFileType,
  disconnectIlink,
  dispatchInboundMessage,
  electronApp,
  existsSync,
  fetchJson,
  getAISourceManager,
  getAllSpacePaths,
  getAppChatConversationId,
  getAppChatSessionState,
  getAppManager,
  getAppRuntime,
  getEnabledAuthProviderConfigs,
  getImChannelManager,
  getImSessionRegistry,
  getPublicSecurityPolicy,
  getServiceConfig,
  getSpace,
  getSpacesDir,
  getTempSpacePath,
  isAbsolute,
  isAppChatGenerating,
  isMcpAppSpec,
  join,
  listArtifacts,
  listArtifactsTree,
  loadAppChatMessages,
  loadImChatMessages,
  loadTreeChildren,
  modelCapabilitiesService,
  moveArtifact,
  patchTouchesMcp,
  readArtifactContent,
  readSessionMessages,
  readdirSync,
  realpathSync,
  reconcileArtifacts,
  rejectIfRemoteMcpForbidden,
  rejectIfRemoteMcpForbiddenAsync,
  rejectIfRemoteBrowserAllowlistForbidden,
  relative,
  renameArtifact,
  resolve,
  restartAppChat,
  saveArtifactContent,
  saveConfig,
  saveIlinkToken,
  sendAppChatMessage,
  spaceController,
  statSync,
  stopAppChat,
  storeController,
  testChannel,
  trashArtifact,
  wecomGenerateScode,
  wecomPollResult,
  yamlIsMcpSpec
}
export type {
  ActivityQueryOptions,
  AppChatRequest,
  AppErrorCode,
  AppListFilter,
  EscalationResponse,
  InstalledApp,
  ModelCapabilityOverride,
  NotificationChannelType,
  UninstallOptions
}
