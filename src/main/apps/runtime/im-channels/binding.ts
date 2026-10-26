/**
 * Binding an IM channel instance to a digital human.
 *
 * `appId` is captured when the connection is created (see manager.applyConfig),
 * so rebinding is a lifecycle change, not a hot update — every write here goes
 * through persistInstances (store + applyConfig). Two UI surfaces bind today
 * (global message-channel settings and the digital human's own settings page),
 * so the read-modify-write and its invariants live here rather than in either
 * caller.
 */

import { getAppManager } from '../../manager'
import { getImChannelManager } from '../index'
import { NOT_SAVED_UNREADABLE, persistInstances, readInstances } from './instance-settings'
import type { ImChannelInstanceConfig } from '../../../../shared/types/im-channel'

export interface BindResult {
  success: boolean
  error?: string
  code?: 'BINDING_CHANGED'
}

function notSaved(action: string, instanceId: string): BindResult {
  console.warn(`[ImChannelBinding] ${action} refused: config.json cannot be read`, { instanceId })
  return { success: false, error: NOT_SAVED_UNREADABLE }
}

/**
 * Reject a binding that would silently swallow messages: inbound dispatch drops
 * traffic when the target app is missing or has no space, logging on the main
 * side only, so from the UI it looks like a bot that never answers.
 */
function validateTarget(appId: string): string | null {
  if (!appId) return 'appId is required'
  const appManager = getAppManager()
  if (!appManager) return 'AppManager not initialized'
  const app = appManager.getApp(appId)
  if (!app) return `Digital human "${appId}" not found`
  if (app.spec.type !== 'automation') return 'Only a digital human can receive IM messages'
  if (!app.spaceId) return 'This digital human is global, so it cannot receive IM messages'
  return null
}

/**
 * Which credential a config points at. The provider answers, because the field
 * carrying that identity is brand-specific (`botId`, `appId`, ...); `botId` is
 * the fallback for providers that predate `credentialId`.
 */
function credentialIdOf(instance: ImChannelInstanceConfig): string {
  const provider = getImChannelManager()?.getProvider(instance.type)
  const viaProvider = provider?.credentialId?.(instance.config ?? {})
  return String(viaProvider ?? instance.config?.botId ?? '').trim()
}

/**
 * Two enabled instances sharing a credential would route the same inbound
 * traffic to two digital humans — duplicated on most platforms, and split at
 * random on any platform that delivers each event to a single connection. This
 * was a renderer-side warning only, which a second binding surface would have
 * silently bypassed.
 */
function findDuplicateBot(
  instances: ImChannelInstanceConfig[],
  candidate: ImChannelInstanceConfig
): ImChannelInstanceConfig | undefined {
  const credential = credentialIdOf(candidate)
  if (!credential || !candidate.enabled) return undefined
  return instances.find(other =>
    other.id !== candidate.id
    && other.type === candidate.type
    && other.enabled
    && credentialIdOf(other) === credential
  )
}

/** Point an existing instance at another digital human. */
export function setInstanceApp(instanceId: string, appId: string, expectedAppId?: string): BindResult {
  const invalid = validateTarget(appId)
  if (invalid) return { success: false, error: invalid }

  const instances = readInstances()
  if (!instances) return notSaved('Rebinding', instanceId)
  const target = instances.find(i => i.id === instanceId)
  if (!target) return { success: false, error: `Instance "${instanceId}" not found` }
  if (expectedAppId !== undefined && target.appId !== expectedAppId) {
    console.warn('[ImChannelBinding] Rebinding refused because the current binding changed', { instanceId, appId })
    return { success: false, code: 'BINDING_CHANGED', error: 'The bot binding changed. Refresh and confirm again.' }
  }
  if (target.appId === appId && !target.teamId) return { success: true }

  // Binding is what lets the manager start an instance (enabled + appId), so
  // an unbound instance whose credential is already live elsewhere must be
  // caught here, not just in createInstance.
  if (findDuplicateBot(instances, { ...target, appId })) {
    return { success: false, error: 'This bot is already bound to another digital human' }
  }

  persistInstances(instances.map(i => {
    if (i.id !== instanceId) return i
    const rebound = { ...i, appId }
    delete rebound.teamId
    return rebound
  }))
  console.log(`[ImChannelBinding] instance ${instanceId} rebound to app ${appId}`)
  return { success: true }
}

/**
 * Detach an instance from its digital human.
 *
 * The bot keeps its credentials in global settings but stops connecting —
 * manager.applyConfig skips instances without an appId — so this is "stop
 * answering", not "forget this bot".
 */
export function unbindInstance(instanceId: string): BindResult {
  const instances = readInstances()
  if (!instances) return notSaved('Unbinding', instanceId)
  const target = instances.find(i => i.id === instanceId)
  if (!target) return { success: false, error: `Instance "${instanceId}" not found` }
  if (!target.appId) return { success: true }

  persistInstances(instances.map(i => i.id === instanceId ? { ...i, appId: '' } : i))
  console.log(`[ImChannelBinding] instance ${instanceId} unbound`)
  return { success: true }
}

/** Add an instance that is already bound to a digital human. */
export function createInstance(instance: ImChannelInstanceConfig): BindResult {
  const invalid = validateTarget(instance?.appId ?? '')
  if (invalid) return { success: false, error: invalid }

  const instances = readInstances()
  if (!instances) return notSaved('Creating', instance.id)
  if (instances.some(i => i.id === instance.id)) {
    return { success: false, error: `Instance "${instance.id}" already exists` }
  }
  if (findDuplicateBot(instances, instance)) {
    return { success: false, error: 'This bot is already bound to another digital human' }
  }

  persistInstances([...instances, instance])
  console.log(`[ImChannelBinding] instance ${instance.id} (${instance.type}) created for app ${instance.appId}`)
  return { success: true }
}
