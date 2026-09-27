export interface CapabilityConsumer {
  appId: string
  name: string
  spaceId: string | null
  /** Availability for independent tasks; chat inheritance is reported separately. */
  access: 'available' | 'enabled' | 'disabled'
  retainedWork?: boolean
  currentScope?: boolean
  chatAccess?: boolean
  automationAccess?: boolean
}

export interface CapabilityInventoryEntry {
  appId: string
  specId: string
  type: 'mcp' | 'skill'
  spaceId: string | null
  consumers: CapabilityConsumer[]
}

export interface CapabilityInventory {
  entries: CapabilityInventoryEntry[]
}

export interface PersonConnectionAccess {
  specId: string
  instanceId?: string
  name: string
  declared: boolean
  enabled: boolean
  installed: boolean
  configured: boolean
  health: 'not_checked'
  chatAccess: boolean
  automationAccess: boolean
}

export interface RetainedCapabilityBinding {
  appId: string
  bindings: Record<string, string>
  mode: 'chat' | 'automation'
}
