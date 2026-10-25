import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({
  t: (text: string, values?: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values?.[key] ?? ''),
}) }))
import { LegacyTeamNotice } from '../../../src/renderer/components/team/workbench/LegacyTeamNotice'

const render = (ownedHere: boolean, ownerName: string | null, repairing = false) => renderToStaticMarkup(createElement(LegacyTeamNotice, {
  recovery: { ownedHere, ownerName, repairFailed: !repairing }, repairing,
  onRetry: () => {}, onCreate: () => {},
}))

describe('legacy team recovery instructions', () => {
  it('explains deferred repair and offers a return to the running conversation', () => {
    const html = renderToStaticMarkup(createElement(LegacyTeamNotice, {
      recovery: { ownedHere: true, ownerName: null, repairDeferred: true }, repairing: false,
      onRetry: () => {}, onCreate: () => {}, onReturn: () => {},
    }))
    expect(html).toContain('Let it finish or stop it there, then retry')
    expect(html).toContain('>Return to conversation<')
    expect(html).not.toContain('could not be repaired')
    expect(html).not.toContain('>New team<')
  })

  it('asks the named teammate to update and reopen, explicitly excluding the reader', () => {
    const html = render(false, 'Alice')
    expect(html).toContain('Ask Alice to update their client and reopen this team')
    expect(html).toContain('You do not need to update.')
    expect(html).not.toContain('>Retry<')
  })

  it('still identifies another person when the creator name is unknown', () => {
    expect(render(false, null)).toContain('its creator, another teammate')
  })

  it('offers repair retry and a new team to its already updated owner, never another upgrade', () => {
    const html = render(true, null)
    expect(html).toContain('>Retry<')
    expect(html).toContain('>New team<')
    expect(html).not.toContain('update')
  })

  it('shows ongoing repair and disables repeat actions while the owner waits', () => {
    const html = render(true, null, true)
    expect(html).toContain('Repairing your previously saved team')
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
})
