import { describe, expect, it } from 'vitest'
import { getCapabilityInventory } from '../../../../src/main/apps/manager/capability-inventory'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager/types'

function app(id: string, type: 'automation' | 'mcp' | 'skill', spaceId: string | null, specId = id, overrides = {}): InstalledApp {
  return { id, spaceId, specId, status: 'active', spec: { name: specId, type }, ...overrides } as InstalledApp
}

function inventory(apps: InstalledApp[]) {
  return getCapabilityInventory({ listApps: () => apps } as unknown as AppManagerService).entries
}

describe('capability inventory impact', () => {
  it('does not attribute an overridden global connection to a person in the overriding space', () => {
    const people = ['a', 'b'].map(space => app(`person-${space}`, 'automation', space, undefined, {
      spec: { name: `Person ${space}`, type: 'automation', requires: { mcps: [{ id: 'calendar' }] } },
    }))
    const entries = inventory([app('global', 'mcp', null, 'calendar'), app('local', 'mcp', 'a', 'calendar'), ...people])
    expect(entries.find(entry => entry.appId === 'global')?.consumers.map(person => person.appId)).toEqual(['person-b'])
    expect(entries.find(entry => entry.appId === 'local')?.consumers.map(person => person.appId)).toEqual(['person-a'])
  })

  it('distinguishes inherited chat access from declared task access in shared-change impact', () => {
    const entries = inventory([
      app('connection', 'mcp', null), app('unrelated', 'automation', 'a'),
      app('person', 'automation', 'a', undefined, { spec: { name: 'Person', type: 'automation', requires: { mcps: [{ id: 'connection', enabled: false }] } } }),
    ])
    expect(entries[0].consumers).toEqual([
      { appId: 'unrelated', name: 'unrelated', spaceId: 'a', currentScope: true, access: 'disabled', chatAccess: true, automationAccess: false },
      { appId: 'person', name: 'Person', spaceId: 'a', currentScope: true, access: 'disabled', chatAccess: false, automationAccess: false },
    ])
  })

  it('scopes skills, preserves global fallback when a local skill is disabled, and excludes uninstalled people', () => {
    const entries = inventory([
      app('global', 'skill', null, 'review'), app('local', 'skill', 'a', 'review', { status: 'paused' }),
      app('person', 'automation', 'a'), app('removed', 'automation', 'a', undefined, { status: 'uninstalled' }),
      app('other-skill', 'skill', 'b'),
    ])
    expect(entries.find(entry => entry.appId === 'global')?.consumers).toHaveLength(1)
    expect(entries.find(entry => entry.appId === 'local')?.consumers[0].access).toBe('disabled')
    expect(entries.find(entry => entry.appId === 'other-skill')?.consumers).toEqual([])
  })

  it('includes retained work after a default-space move and respects current revocations', () => {
    const person = app('person', 'automation', 'new')
    const resources = [app('old-account', 'mcp', 'old', 'calendar'), person]
    const manager = { listApps: () => resources } as unknown as AppManagerService
    const retained = [{ appId: person.id, bindings: { calendar: 'old-account' }, mode: 'chat' as const }]
    const entry = getCapabilityInventory(manager, retained).entries[0]
    expect(entry.consumers).toEqual([{ appId: 'person', name: 'person', spaceId: 'new', access: 'available', retainedWork: true, currentScope: false }])
    person.spec.requires = { mcps: [{ id: 'calendar', enabled: false }] }
    expect(getCapabilityInventory(manager, retained).entries[0].consumers).toEqual([])
    expect(getCapabilityInventory(manager, []).entries[0].consumers).toEqual([])
  })

  it('never returns configuration secrets or conversation content', () => {
    const entries = inventory([app('connection', 'mcp', null, undefined, { userConfig: { token: 'fixture-secret' } })])
    expect(JSON.stringify(entries)).not.toContain('fixture-secret')
    expect(Object.keys(entries[0]).sort()).toEqual(['appId', 'consumers', 'spaceId', 'specId', 'type'])
  })
})
