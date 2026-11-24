import { createContext, useContext } from 'react'

/** Where the replies of a transcript outside the chat store's active conversation keep their file changes. */
export interface ChangesScope {
  spaceId: string
  conversationId: string
}

export const ChangesScopeContext = createContext<ChangesScope | null>(null)

export const useChangesScope = () => useContext(ChangesScopeContext)
