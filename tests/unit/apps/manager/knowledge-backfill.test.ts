/**
 * Unit tests for apps/manager/knowledge-backfill
 *
 * The backfill is a startup maintenance task over the installed-app
 * population, so it is tested against a stub AppManagerService: what matters
 * is which apps it selects and that one failure cannot abort the rest.
 */

import { describe, it, expect, vi } from 'vitest'
import { backfillKnowledgeSeeds } from '../../../../src/main/apps/manager/knowledge-backfill'
import type { AppManagerService, InstalledApp, AppListFilter, AppStatus } from '../../../../src/main/apps/manager/types'

interface StubApp {
  id: string
  status: AppStatus
  type: string
  knowledgeSeeded: boolean
}

function createStubManager(apps: StubApp[]) {
  const ensureKnowledgeSeeded = vi.fn((appId: string) => {
    const app = apps.find(a => a.id === appId)
    if (app) app.knowledgeSeeded = true
  })

  const manager = {
    listApps: (filter?: AppListFilter) =>
      apps
        .filter(a => !filter?.type || a.type === filter.type)
        .filter(a => !filter?.status || a.status === filter.status)
        .map(a => ({
          id: a.id,
          status: a.status,
          knowledgeSeeded: a.knowledgeSeeded,
          spec: { type: a.type },
        })) as unknown as InstalledApp[],
    ensureKnowledgeSeeded,
  } as unknown as AppManagerService

  return { manager, ensureKnowledgeSeeded }
}

describe('backfillKnowledgeSeeds', () => {
  it('seeds unseeded automation apps in every live status, not just active', () => {
    const { manager, ensureKnowledgeSeeded } = createStubManager([
      { id: 'active', status: 'active', type: 'automation', knowledgeSeeded: false },
      { id: 'paused', status: 'paused', type: 'automation', knowledgeSeeded: false },
      { id: 'error', status: 'error', type: 'automation', knowledgeSeeded: false },
      { id: 'needs-login', status: 'needs_login', type: 'automation', knowledgeSeeded: false },
      { id: 'waiting', status: 'waiting_user', type: 'automation', knowledgeSeeded: false },
    ])

    backfillKnowledgeSeeds(manager)

    expect(ensureKnowledgeSeeded.mock.calls.map(c => c[0])).toEqual([
      'active', 'paused', 'error', 'needs-login', 'waiting',
    ])
  })

  it('skips uninstalled apps so removed apps leave no dangling KB bindings', () => {
    const { manager, ensureKnowledgeSeeded } = createStubManager([
      { id: 'gone', status: 'uninstalled', type: 'automation', knowledgeSeeded: false },
    ])

    backfillKnowledgeSeeds(manager)

    expect(ensureKnowledgeSeeded).not.toHaveBeenCalled()
  })

  it('skips already-seeded apps and non-automation types', () => {
    const { manager, ensureKnowledgeSeeded } = createStubManager([
      { id: 'seeded', status: 'active', type: 'automation', knowledgeSeeded: true },
      { id: 'skill', status: 'active', type: 'skill', knowledgeSeeded: false },
      { id: 'mcp', status: 'active', type: 'mcp', knowledgeSeeded: false },
    ])

    backfillKnowledgeSeeds(manager)

    expect(ensureKnowledgeSeeded).not.toHaveBeenCalled()
  })

  it('continues past a per-app failure', () => {
    const { manager, ensureKnowledgeSeeded } = createStubManager([
      { id: 'boom', status: 'active', type: 'automation', knowledgeSeeded: false },
      { id: 'ok', status: 'active', type: 'automation', knowledgeSeeded: false },
    ])
    ensureKnowledgeSeeded.mockImplementationOnce(() => { throw new Error('boom') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => backfillKnowledgeSeeds(manager)).not.toThrow()

    expect(ensureKnowledgeSeeded.mock.calls.map(c => c[0])).toEqual(['boom', 'ok'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('is a no-op on a second run once every app is seeded', () => {
    const { manager, ensureKnowledgeSeeded } = createStubManager([
      { id: 'a', status: 'active', type: 'automation', knowledgeSeeded: false },
    ])

    backfillKnowledgeSeeds(manager)
    backfillKnowledgeSeeds(manager)

    expect(ensureKnowledgeSeeded).toHaveBeenCalledTimes(1)
  })
})
