/**
 * IM Sessions IPC Handlers
 *
 * Provides session list and management for the Settings UI.
 * The registry is populated automatically by dispatch-inbound when
 * users message the bot; these handlers expose read, rename, toggle
 * auto-sync (proactive flag), and remove.
 *
 * Registered from the typed RPC contract (passthrough — handler bodies and
 * return shapes preserved verbatim). Generic, provider-agnostic (ARCHITECTURE §22).
 */

import { getImSessionRegistry } from '../apps/runtime/im-session-registry'
import { imSessionsRpc } from '../../shared/rpc/contracts/im-sessions.contract'
import { registerRawRpcHandlers } from './rpc'

export function registerImSessionHandlers(): void {
  registerRawRpcHandlers(imSessionsRpc, {
    // List IM sessions — if appId is provided, filter by app; otherwise return all
    imSessionsList: async (appId?: string) => {
      try {
        const registry = getImSessionRegistry()
        if (!registry) {
          return { success: true, data: [] }
        }
        const sessions = appId ? registry.getAllSessions(appId) : registry.listAll()
        return { success: true, data: sessions }
      } catch (error: unknown) {
        return { success: false, error: (error as Error).message }
      }
    },
    // Toggle a session's auto-sync flag. When proactive=true, the run's
    // final assistant text is pushed to this contact at run completion by
    // apps/runtime/im-auto-sync.ts.
    imSessionsSetProactive: async (input: { appId: string; channel: string; chatId: string; proactive: boolean }) => {
      try {
        const registry = getImSessionRegistry()
        if (!registry) {
          return { success: false, error: 'IM session registry not initialized' }
        }
        const updated = registry.setProactive(input.appId, input.channel, input.chatId, input.proactive)
        if (!updated) {
          return { success: false, error: 'Session not found' }
        }
        return { success: true }
      } catch (error: unknown) {
        return { success: false, error: (error as Error).message }
      }
    },
    // Remove a session from the registry
    imSessionsRemove: async (input: { appId: string; channel: string; chatId: string }) => {
      try {
        const registry = getImSessionRegistry()
        if (!registry) {
          return { success: false, error: 'IM session registry not initialized' }
        }
        const removed = registry.removeSession(input.appId, input.channel, input.chatId)
        return { success: true, data: { removed } }
      } catch (error: unknown) {
        return { success: false, error: (error as Error).message }
      }
    },
    // Set a custom display name for a session
    imSessionsSetCustomName: async (input: { appId: string; channel: string; chatId: string; name: string }) => {
      try {
        const registry = getImSessionRegistry()
        if (!registry) {
          return { success: false, error: 'IM session registry not initialized' }
        }
        const updated = registry.setCustomName(input.appId, input.channel, input.chatId, input.name)
        if (!updated) {
          return { success: false, error: 'Session not found' }
        }
        return { success: true }
      } catch (error: unknown) {
        return { success: false, error: (error as Error).message }
      }
    },
  })

  console.log('[ImSessions] IPC handlers registered')
}
