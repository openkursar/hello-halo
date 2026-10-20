/**
 * Settings changes to IM channel instances, applied onto the stored list.
 *
 * Main writes instance fields of its own — the owner a first direct message
 * claims (owner-claim.ts), a WeChat token (weixin-ilink controller) — while a
 * settings page keeps the copy it loaded. Writing that copy back would undo
 * those writes, so a client sends only what the person did: changed fields of
 * one instance, an added instance, a removed one.
 *
 * Every write here, and every binding write (binding.ts), persists and
 * re-applies the list to the running manager together.
 */

import { getConfig, isConfigUnreadable, saveConfig } from '../../../foundation/config.service'
import { MASK_SENTINEL } from '../../../foundation/config-encryption'
import { getImChannelManager, dispatchInboundMessage, invalidateImSessions } from '../index'
import type { ImChannelInstanceConfig, ImChannelInstancePatch } from '../../../../shared/types/im-channel'

const LOG_TAG = '[ImChannelSettings]'

/** A write that went through answers with the stored list, which the client shows in place of its copy. */
export type InstanceSettingsResult =
  | { success: true; data: ImChannelInstanceConfig[] }
  | { success: false; error: string }

export const NOT_SAVED_UNREADABLE = 'Not saved: the configuration file cannot be read, so saving is paused to protect its contents'

/**
 * The stored list a write builds on, or null while config.json cannot be read:
 * that read answers the built-in defaults and saveConfig keeps nothing, so the
 * write would report a lost change and re-apply a list without the other bots.
 * The check follows this read, not an earlier one.
 */
export function readInstances(): ImChannelInstanceConfig[] | null {
  const instances = getConfig().imChannels?.instances ?? []
  return isConfigUnreadable() ? null : instances
}

/** Store the list and re-apply it; `appId` is captured when a connection is created, so a write is a lifecycle change. */
export function persistInstances(instances: ImChannelInstanceConfig[]): void {
  const config = getConfig()
  saveConfig({ imChannels: { ...config.imChannels, instances } })
  const manager = getImChannelManager()
  if (!manager) return
  manager.applyConfig(instances, (instanceId, appId, msg, reply) => {
    dispatchInboundMessage(msg, reply, appId, instanceId)
  })
  invalidateImSessions()
}

function refuse(action: string, instanceId: string, error: string): InstanceSettingsResult {
  console.warn(`${LOG_TAG} ${action} refused: instanceId=${instanceId || '(none)'}, reason=${error}`)
  return { success: false, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function patchError(patch: unknown): string | null {
  if (!isRecord(patch)) return 'The change must be an object'
  if ('id' in patch || 'type' in patch) return 'An instance keeps its id and type'
  if (patch.enabled === null || patch.appId === null) return 'enabled and appId cannot be removed'
  if (patch.config !== undefined && !isRecord(patch.config)) return 'config must be an object'
  return null
}

function applyPatch(instance: ImChannelInstanceConfig, patch: ImChannelInstancePatch): ImChannelInstanceConfig {
  const next: Record<string, unknown> = { ...instance }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'config' || value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  if (patch.config) {
    const config: Record<string, unknown> = { ...instance.config }
    for (const [key, value] of Object.entries(patch.config)) {
      // A masked secret is what a remote client was shown, not a new value.
      if (value === undefined || value === MASK_SENTINEL) continue
      if (value === null) delete config[key]
      else config[key] = value
    }
    next.config = config
  }
  return next as unknown as ImChannelInstanceConfig
}

/** Field names only: values include secrets and owner IDs. */
function describePatch(patch: ImChannelInstancePatch): string {
  const fields = Object.keys(patch).filter(key => key !== 'config')
  const configKeys = Object.keys(patch.config ?? {}).map(key => `config.${key}`)
  return [...fields, ...configKeys].join(',') || '(none)'
}

/** Apply what a person changed on one instance onto the stored instance. */
export function updateInstanceSettings(instanceId: string, patch: ImChannelInstancePatch): InstanceSettingsResult {
  const invalid = patchError(patch)
  if (invalid) return refuse('Update', instanceId, invalid)

  const instances = readInstances()
  if (!instances) return refuse('Update', instanceId, NOT_SAVED_UNREADABLE)
  const current = instances.find(i => i.id === instanceId)
  if (!current) return refuse('Update', instanceId, `Instance "${instanceId}" not found`)

  const updated = applyPatch(current, patch)
  if (JSON.stringify(updated) === JSON.stringify(current)) return { success: true, data: instances }

  const next = instances.map(i => (i.id === instanceId ? updated : i))
  persistInstances(next)
  console.log(`${LOG_TAG} instance ${instanceId} updated: fields=${describePatch(patch)}`)
  return { success: true, data: next }
}

/**
 * Add an instance from the settings page. Unlike binding's createInstance it
 * may be unbound and half filled: a manually added card is completed later.
 */
export function addInstance(instance: ImChannelInstanceConfig): InstanceSettingsResult {
  const instanceId = isRecord(instance) && typeof instance.id === 'string' ? instance.id : ''
  if (!instanceId) return refuse('Add', '', 'The instance needs an id')
  if (typeof instance.type !== 'string' || !instance.type) return refuse('Add', instanceId, 'The instance needs a type')
  if (!isRecord(instance.config)) return refuse('Add', instanceId, 'config must be an object')

  const instances = readInstances()
  if (!instances) return refuse('Add', instanceId, NOT_SAVED_UNREADABLE)
  if (instances.some(i => i.id === instanceId)) return refuse('Add', instanceId, `Instance "${instanceId}" already exists`)

  const next = [...instances, instance]
  persistInstances(next)
  console.log(`${LOG_TAG} instance ${instanceId} (${instance.type}) added`)
  return { success: true, data: next }
}

/** Removing an instance that is already gone succeeds: the person's intent already holds. */
export function removeInstance(instanceId: string): InstanceSettingsResult {
  const instances = readInstances()
  if (!instances) return refuse('Remove', instanceId, NOT_SAVED_UNREADABLE)
  if (!instances.some(i => i.id === instanceId)) return { success: true, data: instances }

  const next = instances.filter(i => i.id !== instanceId)
  persistInstances(next)
  console.log(`${LOG_TAG} instance ${instanceId} removed`)
  return { success: true, data: next }
}
