export interface PersonReference {
  kind: 'team'
  teamId: string
  appId: string
  label: string
  epochId?: string
}

export interface PersonContextCaller {
  authority: 'owner' | 'team' | 'guest'
  appId?: string
  teamId?: string
  epochId?: string
  environmentSpaceId?: string
  capabilityMode?: 'chat' | 'automation'
}

export interface PersonContextQuery {
  appId?: string
  section: 'teams' | 'work' | 'capabilities'
  offset?: number
  teamId?: string
  epochId?: string
}

export interface PersonTeamContext {
  teamId: string
  name: string
  role: string
  duty: string | null
  isLead: boolean
  availability: 'local' | 'last_synced'
  updatedAt: number
  reference: PersonReference
}

export interface PersonContextResult {
  identity: { appId: string; name: string; description: string }
  scope: PersonContextCaller['authority']
  retrievedAt: number
  teams?: PersonTeamContext[]
  work?: { teamId: string; epochId: string; title: string | null; status: string; updatedAt: number; summary?: string }
  capabilities?: {
    mode: 'chat' | 'automation' | 'overview'
    effectiveOn: 'next_turn'
    skills: { name: string; scope: string }[]
    connections: PersonConnectionAccess[]
  }
  nextOffset?: number
  references: PersonReference[]
}
import type { PersonConnectionAccess } from './capability-inventory'
