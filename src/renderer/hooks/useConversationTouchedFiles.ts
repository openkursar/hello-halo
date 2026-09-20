/**
 * useConversationTouchedFiles — files the AI wrote or edited in the
 * currently active conversation. Not git status: many spaces are plain
 * local folders with no repo, so this is scoped to "did the AI touch this
 * file in the conversation you're looking at" instead.
 *
 * Recomputed whenever the active conversation changes, from each assistant
 * message's already-persisted `metadata.fileChanges` (no thoughts load
 * needed). Scope is deliberately "this conversation", not "recently" or
 * space-wide: switch conversations and the result switches with it, for as
 * long as that conversation's history exists — it doesn't decay over time.
 *
 * Two consumers: ArtifactTree (renders the badge) and SpacePage (auto-opens
 * the artifact rail when this grows within the active conversation).
 */

import { useMemo } from 'react'
import { useChatStore } from '../stores/chat.store'
import { normalizeFileChangesSummary } from '../../shared/file-changes'

export type TouchedFileStatus = 'created' | 'edited'

export function useConversationTouchedFiles(): Map<string, TouchedFileStatus> {
  const messages = useChatStore(state => {
    const conversationId = state.getCurrentSpaceState().currentConversationId
    return conversationId ? state.conversationCache.get(conversationId)?.messages : undefined
  })

  return useMemo(() => {
    const map = new Map<string, TouchedFileStatus>()
    if (!messages) return map
    for (const message of messages) {
      const summary = normalizeFileChangesSummary(message.metadata?.fileChanges)
      if (!summary) continue
      // Edited fills in first so a later Write for the same file can
      // promote it to "created" — a full rewrite supersedes a prior partial
      // edit, but a later partial edit doesn't erase an earlier full write.
      for (const e of summary.edited) {
        if (!map.has(e.file)) map.set(e.file, 'edited')
      }
      for (const c of summary.created) {
        map.set(c.file, 'created')
      }
    }
    return map
  }, [messages])
}
