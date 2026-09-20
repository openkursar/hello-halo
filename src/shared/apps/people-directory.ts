import type { AppStatus, AutomationAppState } from './app-types'

export interface PeopleDirectoryQuery {
  q?: string
  language?: string
  spaceId?: string
  teamId?: string
  attention?: boolean
  removed?: boolean
  limit?: number
  offset?: number
}

export interface AppDirectoryRecord {
  id: string
  specId: string
  name: string
  description: string
  spaceId: string | null
  status: AppStatus
  installedAt: number
}

export type PersonDirectoryRecord = AppDirectoryRecord

export type StudioSummary = Record<'automation' | 'skill' | 'mcp', { total: number; items: AppDirectoryRecord[] }>

export interface PeopleDirectorySummary extends PersonDirectoryRecord {
  state: AutomationAppState
  teams: Array<{ id: string; name: string }>
}

export interface PeopleDirectoryPage {
  items: PeopleDirectorySummary[]
  total: number
  offset: number
  limit: number
  pendingTotal: number
  removedTotal: number
}

export interface DirectoryMembership {
  appId: string
  teamId: string
  teamName: string
  isSystemCoordinator: boolean
}

export interface DirectoryRuntimeSnapshot {
  [appId: string]: { runningCount: number; queued: boolean; nextRunAtMs?: number }
}

export interface PersonDirectoryFilter extends PeopleDirectoryQuery {
  includeIds?: string[]
  excludeIds?: string[]
  searchTeamMemberIds?: string[]
}
