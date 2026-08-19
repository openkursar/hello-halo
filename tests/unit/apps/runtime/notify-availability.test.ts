/**
 * Unit tests for apps/runtime/notify-availability
 *
 * resolveNotifyAvailability is the single source of truth for whether a digital
 * human's notification tools are actually loaded. A capability toggle being ON
 * is necessary but not sufficient: notify_channel needs a configured external
 * channel, notify_bot needs both the im-push toggle AND a pushable contact.
 */

import { describe, it, expect, vi } from 'vitest'

// getEnabledChannels lives in a module that transitively pulls electron/proxy
// deps; stub it with the same "which channels are enabled" logic it really has.
vi.mock('../../../../src/main/services/notify-channels', () => ({
  getEnabledChannels: (c: Record<string, { enabled?: boolean }> | undefined) => {
    if (!c) return []
    return ['email', 'wecom', 'dingtalk', 'feishu', 'webhook'].filter((k) => c[k]?.enabled)
  },
}))

import { resolveNotifyAvailability } from '../../../../src/main/apps/runtime/notify-availability'

type App = Parameters<typeof resolveNotifyAvailability>[0]

/** App with the given capabilities denied; everything else defaults ON. */
function makeApp(denied: string[] = []): App {
  return { permissions: { granted: [], denied }, spec: {} } as unknown as App
}

/** `n` placeholder pushable sessions — only `.length` is read. */
function sessions(n: number) {
  return Array.from({ length: n }, () => ({})) as any
}

describe('resolveNotifyAvailability', () => {
  it('reports nothing available when no channel and no contact exist', () => {
    const a = resolveNotifyAvailability(makeApp(), undefined, sessions(0))
    expect(a).toEqual({
      channelsConfigured: false,
      emailChannelConfigured: false,
      imContactsAvailable: false,
      notifyBotAvailable: false,
      anyNotifyToolAvailable: false,
    })
  })

  it('flags notify_channel + email when the email channel is enabled', () => {
    const a = resolveNotifyAvailability(makeApp(), { email: { enabled: true } } as any, sessions(0))
    expect(a.channelsConfigured).toBe(true)
    expect(a.emailChannelConfigured).toBe(true)
    expect(a.anyNotifyToolAvailable).toBe(true)
  })

  it('flags a non-email channel without marking email configured', () => {
    const a = resolveNotifyAvailability(makeApp(), { webhook: { enabled: true } } as any, sessions(0))
    expect(a.channelsConfigured).toBe(true)
    expect(a.emailChannelConfigured).toBe(false)
    expect(a.anyNotifyToolAvailable).toBe(true)
  })

  it('flags notify_bot when im-push is on AND a contact exists', () => {
    const a = resolveNotifyAvailability(makeApp(), undefined, sessions(1))
    expect(a.imContactsAvailable).toBe(true)
    expect(a.notifyBotAvailable).toBe(true)
    expect(a.anyNotifyToolAvailable).toBe(true)
  })

  it('does not flag notify_bot when im-push is off, even with contacts', () => {
    const a = resolveNotifyAvailability(makeApp(['im-push']), undefined, sessions(2))
    expect(a.imContactsAvailable).toBe(true)
    expect(a.notifyBotAvailable).toBe(false)
    expect(a.anyNotifyToolAvailable).toBe(false)
  })
})
