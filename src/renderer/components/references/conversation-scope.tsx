/**
 * Which conversation a chat transcript shows, for the replies inside it: a
 * reply's text becomes a reference to that conversation, and its file
 * mentions become links into that conversation's space. Only the main chat
 * provides it — other transcripts (team rooms, run details) render the same
 * message components but are not the chat beside the canvas.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { FileLinkProvider } from './file-links'

export interface ConversationReferenceScopeValue {
  conversationId: string
  conversationTitle: string
}

const ConversationScopeContext = createContext<ConversationReferenceScopeValue | null>(null)

interface ConversationReferenceScopeProps {
  conversationId: string | null
  conversationTitle: string
  /** Space whose files the replies' mentions may link to. */
  spaceId: string | null
  /** The space's working directory, which relative mentions resolve against. */
  baseDir?: string
  children: ReactNode
}

export function ConversationReferenceScope({ conversationId, conversationTitle, spaceId, baseDir, children }: ConversationReferenceScopeProps) {
  const value = useMemo(
    () => (conversationId ? { conversationId, conversationTitle } : null),
    [conversationId, conversationTitle],
  )
  const scoped = <ConversationScopeContext.Provider value={value}>{children}</ConversationScopeContext.Provider>
  return spaceId ? <FileLinkProvider spaceId={spaceId} baseDir={baseDir}>{scoped}</FileLinkProvider> : scoped
}

export function useConversationReferenceScope(): ConversationReferenceScopeValue | null {
  return useContext(ConversationScopeContext)
}
