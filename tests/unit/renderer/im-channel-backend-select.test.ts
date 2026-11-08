/**
 * The bot backend picker offers only the digital humans and teams a person set
 * up — never the members a temporary collaboration built for one piece of work —
 * while a bot already bound to one still shows what it is bound to.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))

import {
  ChannelBackendSelect,
  type ChannelBackendApp,
  type ChannelBackendTeam,
  type ChannelBackendValue,
} from '../../../src/renderer/components/settings/ChannelBackendSelect'

const app = (id: string, name: string, status: ChannelBackendApp['status'] = 'active'): ChannelBackendApp =>
  ({ id, status, spec: { name, type: 'automation' } })

const automationApps = [
  app('own', 'Own Assistant'),
  app('saved-lead', 'Saved · lead'),
  app('saved-member', 'Saved · writer'),
  app('reviewer', 'Release review · reviewer'),
  app('removed', 'Removed Helper', 'uninstalled'),
]

const teams: ChannelBackendTeam[] = [
  {
    id: 'saved',
    name: 'Saved',
    localMembers: [
      { appId: 'saved-lead', memberName: 'lead', isLead: true },
      { appId: 'saved-member', memberName: 'writer', isLead: false },
    ],
  },
  {
    id: 'review',
    name: 'Release review',
    ephemeral: true,
    localMembers: [{ appId: 'reviewer', memberName: 'reviewer', isLead: false }],
  },
]

const render = (value: ChannelBackendValue) =>
  renderToStaticMarkup(createElement(ChannelBackendSelect, { value, automationApps, teams, onChange: () => {} }))

const options = (html: string) =>
  [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(([, attrs, label]) => ({
    label,
    disabled: attrs.includes('disabled'),
    selected: attrs.includes('selected'),
  }))

describe('ChannelBackendSelect — what a bot can be bound to', () => {
  it('offers saved digital humans and teams, not a temporary collaboration or an uninstalled one', () => {
    const html = render({ appId: '' })
    const labels = options(html).map(o => o.label)

    expect(labels).toContain('Own Assistant')
    expect(labels).toContain('writer')
    expect(html).toContain('Team: Saved')
    expect(html).not.toContain('Release review')
    expect(html).not.toContain('Removed Helper')
  })

  it('still names a bot bound to a temporary collaboration member, without offering it to others', () => {
    const asApp = options(render({ appId: 'reviewer' }))
    expect(asApp.filter(o => o.label === 'Release review · reviewer')).toEqual([
      { label: 'Release review · reviewer', disabled: true, selected: true },
    ])

    const asTeamMember = render({ appId: 'reviewer', teamId: 'review' })
    expect(options(asTeamMember).filter(o => o.selected)).toEqual([
      { label: 'reviewer · Team Release review', disabled: true, selected: true },
    ])
    expect(asTeamMember).toContain('reviewer answers this Bot as part of Release review')
    expect(asTeamMember).not.toContain('Team: Release review')
  })

  it('says a binding is unavailable only when its target is gone', () => {
    expect(options(render({ appId: 'purged' })).find(o => o.selected)).toEqual(
      { label: 'Binding unavailable', disabled: true, selected: true },
    )
    expect(options(render({ appId: 'own' })).find(o => o.selected)).toEqual(
      { label: 'Own Assistant', disabled: false, selected: true },
    )
  })
})
