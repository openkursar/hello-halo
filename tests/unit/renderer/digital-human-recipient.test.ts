import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { TeamListItem } from '../../../src/shared/apps/team-types'

const env = vi.hoisted(() => ({ apps: [] as InstalledApp[], teams: [] as TeamListItem[] }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: (select: (state: unknown) => unknown) => select({ apps: env.apps, loadApps: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/team.store', () => ({
  useTeamStore: (select: (state: unknown) => unknown) => select({ teams: env.teams }),
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ startDigitalHumanConversation: vi.fn() }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({
  AutomationAvatar: ({ name }: { name: string }) => createElement('span', { 'data-avatar': name }),
}))

import { useSpaceDigitalHumans } from '../../../src/renderer/hooks/useSpaceDigitalHumans'
import { DigitalHumanSelector } from '../../../src/renderer/components/chat/DigitalHumanSelector'

function Candidates({ includeUninstalled = false }: { includeUninstalled?: boolean }) {
  return createElement('span', null, useSpaceDigitalHumans('space', { includeUninstalled }).map(app => app.id).join(','))
}

const chip = (currentName?: string, options: { appId: string; name: string; status: 'active' }[] = []) => renderToStaticMarkup(createElement(DigitalHumanSelector, {
  current: 'lead', currentName, options, locked: false, onChange: vi.fn(),
}))

describe('personal-chat recipients and current identity', () => {
  it('includes locally installed persistent team members while preserving space, type and temporary-member scope', () => {
    env.apps = [
      ['lead', 'space', 'automation', 'active'],
      ['member', 'space', 'automation', 'paused'],
      ['temporary', 'space', 'automation', 'active'],
      ['writer', 'space', 'automation', 'active'],
      ['analyst', 'space', 'automation', 'active'],
      ['researcher', 'space', 'automation', 'active'],
      ['elsewhere', 'other-space', 'automation', 'active'],
      ['skill', 'space', 'skill', 'active'],
      ['removed', 'space', 'automation', 'uninstalled'],
    ].map(([id, spaceId, type, status]) => ({ id, spaceId, spec: { type }, status }) as InstalledApp)
    env.teams = [
      { localMembers: [{ appId: 'lead', isSystemCoordinator: true }, { appId: 'member' }, { appId: 'writer' }, { appId: 'analyst' }, { appId: 'researcher' }] },
      { ephemeral: true, localMembers: [{ appId: 'temporary', isSystemCoordinator: true }, { appId: 'writer' }, { appId: 'analyst' }, { appId: 'researcher' }] },
      { localMembers: [{ appId: 'not-installed-here', isSystemCoordinator: true }] },
    ] as TeamListItem[]
    expect(renderToStaticMarkup(createElement(Candidates))).toBe('<span>lead,member,writer,analyst,researcher</span>')
    expect(renderToStaticMarkup(createElement(Candidates, { includeUninstalled: true }))).toBe('<span>lead,member,writer,analyst,researcher,removed</span>')
    env.teams.reverse()
    expect(renderToStaticMarkup(createElement(Candidates))).toBe('<span>lead,member,writer,analyst,researcher</span>')
  })

  it('shows the open chat identity even when absent from the candidate list', () => {
    const html = chip('Research Lead')
    expect(html).toContain('data-avatar="Research Lead"')
    expect(html).toContain('>Research Lead</span>')
    expect(html).not.toContain('>Digital human</span>')
    expect(html).toContain('Switch back to Halo')
  })

  it('prefers the current identity over stale option metadata', () => {
    expect(chip('Renamed Lead', [{ appId: 'lead', name: 'Old Lead', status: 'active' }])).toContain('data-avatar="Renamed Lead"')
  })

  it('retains option identity and the clear control when current details are unavailable', () => {
    expect(chip(undefined, [{ appId: 'lead', name: 'Lead', status: 'active' }])).toContain('data-avatar="Lead"')
    expect(chip()).toContain('>Digital human</span>')
    expect(chip()).toContain('Switch back to Halo')
  })
})
