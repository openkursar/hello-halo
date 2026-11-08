import type { SkillSpec } from '../apps/spec-types'

export interface SkillRef {
  spaceId: string | null
  id: string
}

export type SkillSource = 'personal' | 'store' | 'digital-human' | 'builtin'
export type SkillGroupSource = 'mine' | 'digital-human' | 'builtin'
export type SkillAvailability = 'available' | 'disabled' | 'overridden' | 'conflict' | 'missing' | 'invalid'

export interface SkillCopy {
  id: string
  appId?: string
  name: string
  displayName: string
  description: string
  author?: string
  version?: string
  icon?: SkillSpec['icon']
  i18n?: SkillSpec['i18n']
  path: string
  scope: 'global' | 'space'
  spaceId: string | null
  source: SkillSource
  owners: Array<{ id: string; name: string }>
  enabled: boolean
  availability: SkillAvailability
  error?: string
  revision: string
  editable: boolean
  isLink: boolean
}

export interface SkillGroup {
  name: string
  displayName: string
  description: string
  source: SkillGroupSource
  copies: SkillCopy[]
  effectiveId?: string
  conflict: boolean
}

export interface LegacySkill {
  appId: string
  name: string
  description: string
  spaceId: string | null
}

export interface SkillListQuery {
  spaceId: string | null
  q?: string
  source?: 'all' | SkillGroupSource
  offset?: number
  limit?: number
}

export interface SkillInventory {
  groups: SkillGroup[]
  offset: number
  limit: number
  total: number
  truncated: boolean
  warnings: string[]
  legacyRemoved: LegacySkill[]
}

export interface SkillDetail {
  copy: SkillCopy
  content: string
  revision: string
  files: Array<{ path: string; size: number; binary: boolean }>
  spec: SkillSpec
}

export interface SkillSaveInput {
  ref: SkillRef
  content: string
  revision: string
}

export interface SkillImportInput {
  spaceId: string | null
  spec: SkillSpec
  requestId: string
  replace?: { ref: SkillRef; revision: string }
}

export interface SkillMoveInput {
  ref: SkillRef
  spaceId: string | null
  revision: string
}

export interface SkillMovePreview {
  fromPath: string
  toPath: string
  fromSpaceId: string | null
  toSpaceId: string | null
  conflict?: string
}

export interface SkillCopyInput {
  ref: SkillRef
  spaceId: string | null
  name: string
  content?: string
}

export type SkillNotice = 'catalog-unavailable'

export interface SkillCatalogEntry {
  name: string
  description: string
  whenToUse?: string
  argumentHint?: string
  source: { kind: 'file'; path: string }
}

/** Internal installation metadata, never accepted from an imported skill package. */
export interface SkillInstallationState {
  version: 1
  filePath: string
  /** Fingerprint of the files Halo last wrote, to tell later edits made outside Halo. */
  digest?: string
  deleted?: boolean
  customized?: boolean
  migrationWarning?: string
  owners?: Array<{ id: string; name: string }>
  requestId?: string
}
