/**
 * How an IM bot's connection reads in Settings (components/settings/ImLinkStatus).
 *
 * A bot that is enabled but not running — no digital human bound, config
 * incomplete, refused as a duplicate — has no link Halo is bringing back, so it
 * must read as disconnected, not as connecting / reconnecting by itself.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ImChannelInstanceStatus } from '../../../src/shared/types/im-channel'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))

import { imConnectionState, imLinkView, imSectionSummary } from '../../../src/renderer/components/settings/ImLinkStatus'

const t = ((text: string) => text) as never

function status(overrides: Partial<ImChannelInstanceStatus> = {}): ImChannelInstanceStatus {
  return { id: 'i1', type: 'wecom-bot', enabled: true, connected: false, appId: '', ...overrides }
}

/** What the manager reports for an enabled instance that never started a link. */
const notRunning = status({ state: 'connecting', reason: 'Bot ID already used by another instance' })
const dialing = status({ state: 'connecting', link: { attempt: 1, viaProxy: false, drops: 0, lastError: 'connect ETIMEDOUT' } })

describe('IM link status in Settings', () => {
  it('shows an enabled bot with no running link as disconnected', () => {
    expect(imConnectionState(notRunning)).toBe('offline')
    expect(imLinkView(notRunning, true, t).label).toBe('Disconnected')
    expect(imSectionSummary([notRunning], 'wecom-bot', 1, t).label).toBe('Disconnected')
  })

  it('still shows a bot whose link is being dialled as connecting', () => {
    expect(imConnectionState(dialing)).toBe('connecting')
    expect(imLinkView(dialing, true, t).label).toBe('Connecting…')
    expect(imSectionSummary([dialing], 'wecom-bot', 1, t).label).toBe('Reconnecting…')
  })
})
