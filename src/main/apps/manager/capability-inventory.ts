import type { AppManagerService, InstalledApp } from './types'
import type { CapabilityInventory, CapabilityConsumer, PersonConnectionAccess, RetainedCapabilityBinding } from '../../../shared/apps/capability-inventory'
import { toSkillDirName } from '../../../shared/skill-naming'

/** Installed resource impact, including disabled declarations. Disk-only skills remain in skill discovery. */
export function getCapabilityInventory(manager: AppManagerService, retained: RetainedCapabilityBinding[] = []): CapabilityInventory {
  const apps = manager.listApps().filter(app => app.status !== 'uninstalled')
  const people = apps.filter(app => app.spec.type === 'automation')
  const resources = apps.filter(app => app.spec.type === 'mcp' || app.spec.type === 'skill')
  const scopedResources = new Set(resources.filter(resource => resource.spaceId !== null &&
    (resource.spec.type !== 'skill' || resource.status === 'active')).map(resource =>
    JSON.stringify([resource.spaceId, resource.spec.type, resource.spec.type === 'skill' ? toSkillDirName(resource.specId) : resource.specId])))
  const retainedByInstance = new Map<string, Set<string>>()
  const peopleById = new Map(people.map(person => [person.id, person]))
  for (const work of retained) {
    const person = peopleById.get(work.appId)
    if (!person) continue
    for (const [specId, instanceId] of Object.entries(work.bindings)) {
      const dependency = person.spec.requires?.mcps?.find(item => item.id === specId)
      if (dependency?.enabled === false || (work.mode === 'automation' && !dependency)) continue
      const ids = retainedByInstance.get(instanceId) ?? new Set<string>()
      ids.add(person.id)
      retainedByInstance.set(instanceId, ids)
    }
  }
  return {
    entries: resources.map(resource => {
      const consumers: CapabilityConsumer[] = []
      for (const person of people) {
        if (resource.spaceId !== null && resource.spaceId !== person.spaceId) continue
        const key = resource.spec.type === 'skill' ? toSkillDirName(resource.specId) : resource.specId
        const overridden = resource.spaceId === null && person.spaceId !== null &&
          scopedResources.has(JSON.stringify([person.spaceId, resource.spec.type, key]))
        if (overridden) continue
        const dependency = person.spec.requires?.mcps?.find(dep => dep.id === resource.specId)
        consumers.push({
          appId: person.id, name: person.spec.name, spaceId: person.spaceId, currentScope: true,
          access: resource.spec.type === 'skill' ? resource.status === 'active' ? 'available' : 'disabled' : dependency && dependency.enabled !== false ? 'enabled' : 'disabled',
          ...(resource.spec.type === 'mcp' ? {
            chatAccess: resource.status === 'active' && dependency?.enabled !== false,
            automationAccess: resource.status === 'active' && !!dependency && dependency.enabled !== false,
          } : {}),
        })
      }
      for (const appId of retainedByInstance.get(resource.id) ?? []) {
        const existing = consumers.find(person => person.appId === appId)
        if (existing) existing.retainedWork = true
        else {
          const person = peopleById.get(appId)!
          consumers.push({ appId, name: person.spec.name, spaceId: person.spaceId, access: 'available', retainedWork: true, currentScope: false })
        }
      }
      return {
        appId: resource.id, specId: resource.specId,
        type: resource.spec.type as 'mcp' | 'skill', spaceId: resource.spaceId, consumers,
      }
    }),
  }
}

/** Scope and declarations only; never returns connection configuration or probes health. */
export function getPersonConnectionAccess(
  manager: Pick<AppManagerService, 'listEffectiveMcpApps'>,
  app: InstalledApp,
  spaceId: string | null = app.spaceId,
): PersonConnectionAccess[] {
  const resources = manager.listEffectiveMcpApps(spaceId ?? '')
  const dependencies = app.spec.requires?.mcps ?? []
  const ids = new Set([...resources.map(resource => resource.specId), ...dependencies.map(dependency => dependency.id)])
  return [...ids].map(specId => {
    const resource = resources.find(item => item.specId === specId)
    const dependency = dependencies.find(item => item.id === specId)
    const enabled = dependency?.enabled !== false
    const active = resource?.status === 'active'
    return {
      specId, instanceId: resource?.id, name: resource?.spec.name ?? specId,
      declared: !!dependency, enabled, installed: !!resource,
      configured: !!resource && resource.spec.type === 'mcp' && !!resource.spec.mcp_server &&
        (resource.spec.config_schema ?? []).every(field => {
          if (!field.required) return true
          const value = resource.userConfig?.[field.key] ?? (resource.spec.type === 'mcp' ? resource.spec.mcp_server.env?.[field.key] : undefined)
          return value !== undefined && value !== null && value !== ''
        }),
      health: 'not_checked', chatAccess: active && enabled, automationAccess: active && enabled && !!dependency,
    }
  })
}
