export type SubagentModelSlot = 'small' | 'medium' | 'large'
export type SubagentModelTarget =
  | { kind: 'model'; sourceId: string; modelId: string }
  | { kind: 'group'; groupId: string }

interface SubagentModelProfileBase {
  id: string
  revision: number
  description: string
}

export type SubagentModelProfile = SubagentModelProfileBase & (
  | { kind: 'builtin'; slot: SubagentModelSlot; target?: SubagentModelTarget }
  | { kind: 'custom'; name: string; target: SubagentModelTarget }
)

export interface SubagentModelSettings {
  version: 1
  selectionMode: 'inherit' | 'task'
  policyRevision: number
  revision: number
  profiles: SubagentModelProfile[]
}

export interface SubagentModelInput {
  name: string
  description: string
  target: SubagentModelTarget
}

export interface SubagentModelUpdate {
  id: string
  expectedRevision: number
  name?: string
  description: string
  target: SubagentModelTarget
}

export interface SubagentModelRevisionInput {
  id: string
  expectedRevision: number
}

export interface SubagentModelModeInput {
  selectionMode: SubagentModelSettings['selectionMode']
  expectedRevision: number
}

export interface SubagentModelsChangedEvent {
  revision: number
  policyRevision: number
}
