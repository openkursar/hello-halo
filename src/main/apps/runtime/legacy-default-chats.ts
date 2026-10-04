/**
 * Conversation-list records for default chats older than the list.
 *
 * Earlier builds opened a digital human's default chat (`chat.jsonl`) by app
 * id and never registered it, while the conversation list shows registered
 * chats only. The one-time environment backfill pins each such non-empty
 * transcript and clearing the chat drops the pin, so a pin without a registry
 * record is exactly a chat the list is missing. No transcript is read: the
 * pin proves content, the file's mtime orders the row.
 */

import { statSync } from 'fs'
import { getAppChatConversationId } from '../../../shared/apps/im-keys'
import { NATIVE_DEFAULT_CHAT_ID, NATIVE_SESSION_CHANNEL } from '../../../shared/types/im-channel'
import type { InstalledApp } from '../manager'
import type { ActivityStore } from './store'
import type { ImSessionRegistry } from './im-session-registry'
import { appChatRunId, legacySessionEnvironmentKey } from './execution-environment'
import { resolveTranscriptPath } from './session-store'

export function restoreLegacyDefaultChats(apps: InstalledApp[], store: ActivityStore, registry: ImSessionRegistry): void {
  let restored = 0
  for (const app of apps) {
    if (registry.findSession(app.id, NATIVE_SESSION_CHANNEL, NATIVE_DEFAULT_CHAT_ID)) continue
    const runId = appChatRunId(getAppChatConversationId(app.id), app.id)
    const environment = store.getSessionEnvironment(legacySessionEnvironmentKey(app.id, runId))
    if (!environment) continue
    try {
      const transcript = resolveTranscriptPath(environment.spacePath, app.id, runId)
      if (!transcript) {
        console.warn(`[Runtime] Default chat of ${app.id} not listed: no transcript in ${environment.spacePath}`)
        continue
      }
      registry.restoreSession({
        appId: app.id,
        channel: NATIVE_SESSION_CHANNEL,
        source: 'native',
        instanceId: '',
        chatId: NATIVE_DEFAULT_CHAT_ID,
        chatType: 'direct',
        displayName: '',
        proactive: false,
        lastActiveAt: statSync(transcript).mtimeMs,
        // Turns taken before the registry are not counted; one marks the chat as holding a conversation.
        messageCount: 1,
      })
      restored++
    } catch (error) {
      console.warn(`[Runtime] Default chat of ${app.id} not listed:`, error)
    }
  }
  if (restored > 0) {
    console.log(`[Runtime] Listed ${restored} default chat(s) kept from before the conversation list tracked them`)
  }
}
