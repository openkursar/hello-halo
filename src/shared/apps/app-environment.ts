export interface AppSpaceChangePreview {
  appId: string
  fromSpaceId: string | null
  toSpaceId: string
  activeRunCount: number
  activeChatCount: number
  pendingDecisionCount: number
  retainedSessionCount: number
  addedSkills: string[]
  removedSkills: string[]
  addedConnections: string[]
  removedConnections: string[]
  addedChatConnections?: string[]
  removedChatConnections?: string[]
  warnings: string[]
}
