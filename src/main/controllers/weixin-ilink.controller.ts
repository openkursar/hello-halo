/**
 * WeChat iLink Controller
 *
 * Business logic for the iLink token lifecycle: persisting credentials
 * after QR login and clearing them on disconnect. Used by both the IPC
 * handler (weixin-ilink.ts) and the HTTP routes (routes/index.ts).
 *
 * Keeping this logic here ensures a single source of truth and avoids
 * the transport layers (IPC / HTTP) from duplicating config-mutation code.
 */

import { getConfig, saveConfig } from '../foundation/config.service'
import { getImChannelManager, dispatchInboundMessage } from '../apps/runtime'

// ============================================
// Token persistence
// ============================================

/**
 * Persist iLink credentials into the instance config after a successful
 * QR scan, then reload the ImChannelManager so the long-poll starts.
 */
export async function saveIlinkToken(
  instanceId: string,
  botToken: string,
  baseUrl?: string,
  accountId?: string
): Promise<{ success: true } | { success: false; error: string }> {
  if (!instanceId || !botToken) {
    return { success: false, error: 'instanceId and botToken are required' }
  }

  const config = getConfig()
  const instances = config.imChannels?.instances ?? []
  const idx = instances.findIndex((inst) => inst.id === instanceId)

  if (idx === -1) {
    return { success: false, error: `Instance "${instanceId}" not found in config` }
  }

  const updatedInstances = instances.map((inst) => {
    if (inst.id !== instanceId) return inst
    return {
      ...inst,
      config: {
        ...inst.config,
        botToken,
        baseUrl: baseUrl ?? (inst.config.baseUrl as string) ?? '',
        accountId: accountId ?? (inst.config.accountId as string) ?? '',
      },
    }
  })

  saveConfig({ imChannels: { ...config.imChannels, instances: updatedInstances } })

  const manager = getImChannelManager()
  if (manager) {
    manager.applyConfig(updatedInstances, (iid, appId, msg, reply) => {
      dispatchInboundMessage(msg, reply, appId, iid)
    })
  }

  console.log(`[WeixinIlink] Token saved for instance ${instanceId} (accountId=${accountId ?? 'n/a'})`)
  return { success: true }
}

// ============================================
// Disconnect
// ============================================

/**
 * Clear all iLink credentials from the instance config and stop its
 * long-poll connection via the ImChannelManager.
 */
export async function disconnectIlink(
  instanceId: string
): Promise<{ success: true } | { success: false; error: string }> {
  if (!instanceId) {
    return { success: false, error: 'instanceId is required' }
  }

  const config = getConfig()
  const instances = config.imChannels?.instances ?? []
  const idx = instances.findIndex((inst) => inst.id === instanceId)

  if (idx === -1) {
    return { success: false, error: `Instance "${instanceId}" not found in config` }
  }

  const updatedInstances = instances.map((inst) => {
    if (inst.id !== instanceId) return inst
    return {
      ...inst,
      config: { ...inst.config, botToken: '', baseUrl: '', accountId: '' },
    }
  })

  saveConfig({ imChannels: { ...config.imChannels, instances: updatedInstances } })

  const manager = getImChannelManager()
  if (manager) {
    manager.applyConfig(updatedInstances, (iid, appId, msg, reply) => {
      dispatchInboundMessage(msg, reply, appId, iid)
    })
  }

  console.log(`[WeixinIlink] Disconnected instance ${instanceId}`)
  return { success: true }
}
