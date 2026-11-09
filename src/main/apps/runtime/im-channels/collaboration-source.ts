import { createHash } from 'crypto'
import type { InstalledApp } from '../../../../shared/apps/app-types'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../../shared/types/im-channel'
import { allowsCollaboration } from '../../../../shared/apps/capability-policy'
import { buildImSessionKey } from '../../../../shared/apps/im-keys'
import type { ImPermissionContext } from '../im-permission-registry'
import { instanceTakesChat, resolveImPermission } from '../im-sender-standing'

export interface ImCollaborationSource {
  kind: 'im'
  version: 1
  appId: string
  conversationId: string
  instanceId: string
  channel: string
  chatId: string
  chatType: 'direct' | 'group'
  contextId: string
  permission: ImPermissionContext
  authorizationHash: string
  appAuthorityHash: string
}

export interface ImSourceState {
  app: InstalledApp
  config: ImChannelInstanceConfig
  session: ImSessionRecord
  contextId: string
}

function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.every(value => typeof value === 'string') ? [...item].sort() : item.map(canonical)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]))
    return item
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function authorizationHash(config: ImChannelInstanceConfig): string {
  return fingerprint([config.id, config.type, config.enabled, config.appId, config.teamId, config.permissionEnabled,
    config.owners, config.guestPolicy, config.replyScope, config.config])
}

function appAuthorityHash(app: InstalledApp): string {
  return fingerprint([app.id, app.spaceId, app.permissions, app.userOverrides?.disabledTools, app.userOverrides?.spaceMemoryAccess === true])
}

export function captureImSource(state: ImSourceState, conversationId: string, permission: ImPermissionContext): ImCollaborationSource {
  const source: ImCollaborationSource = {
    kind: 'im', version: 1, appId: state.app.id, conversationId, instanceId: state.config.id,
    channel: state.session.channel, chatId: state.session.chatId, chatType: state.session.chatType,
    contextId: state.contextId, permission: structuredClone(permission),
    authorizationHash: authorizationHash(state.config), appAuthorityHash: appAuthorityHash(state.app),
  }
  const refusal = imSourceRefusal(source, state)
  if (refusal) throw new Error(`The IM collaboration source is unavailable (${refusal}).`)
  return source
}

/** Revalidate the original caller, never the session's most recent sender. */
export function imSourceRefusal(source: ImCollaborationSource, state: ImSourceState): string | null {
  const { app, config, session, contextId } = state
  if (app.id !== source.appId || app.status === 'uninstalled' || !app.spaceId) return 'app unavailable'
  if (!config.enabled || config.id !== source.instanceId || config.appId !== source.appId || config.teamId || config.type !== source.channel) return 'channel binding changed'
  if (session.appId !== source.appId || session.source !== 'im' || session.instanceId !== source.instanceId || session.channel !== source.channel ||
    session.chatId !== source.chatId || session.chatType !== source.chatType || contextId !== source.contextId || session.teamContext) return 'session context changed'
  if (buildImSessionKey(source.appId, source.channel, source.chatType, source.chatId) !== source.conversationId) return 'conversation mismatch'
  if (!instanceTakesChat(config, source.chatType)) return 'chat no longer accepted'
  if (!source.permission.senderId || (source.chatType === 'direct' && session.contactId && session.contactId !== source.permission.senderId)) return 'caller unavailable'
  const current = resolveImPermission(config, source.permission.senderId, source.permission.senderName)
  if (fingerprint(current) !== fingerprint(source.permission) || authorizationHash(config) !== source.authorizationHash || appAuthorityHash(app) !== source.appAuthorityHash) return 'authorization changed'
  if (!current.isOwner && !allowsCollaboration(current.guestPolicy, 'strict')) return 'collaboration not granted'
  return null
}

export function readImSource(value: Record<string, unknown>): ImCollaborationSource | null {
  if (value.kind !== 'im' || value.version !== 1 || !['direct', 'group'].includes(String(value.chatType))) return null
  if (!['appId', 'conversationId', 'instanceId', 'channel', 'chatId', 'contextId', 'authorizationHash', 'appAuthorityHash'].every(key => typeof value[key] === 'string' && value[key])) return null
  const permission = value.permission as Partial<ImPermissionContext> | undefined
  if (!permission || typeof permission.senderId !== 'string' || typeof permission.senderName !== 'string' || typeof permission.isOwner !== 'boolean') return null
  return value as unknown as ImCollaborationSource
}
