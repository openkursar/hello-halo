/**
 * Unit tests for apps/runtime/prompt/capabilities
 *
 * buildDisabledCapabilitiesGuidance renders the system-prompt fragment that
 * tells a digital human which toggleable capabilities the user turned OFF and
 * where to re-enable them.
 *
 * Core invariants:
 * - Returns null when every toggleable capability is enabled (default state)
 * - A denied capability is listed by its Capabilities-panel label
 * - The guidance points to the digital human's own Capabilities settings, never
 *   to the space-chat toolset broker ("input area")
 * - AI Terminal is omitted when the platform cannot run terminals, even if denied
 * - Always-on capabilities (web search, memory, OCR) are never listed
 */

import { describe, it, expect, vi } from 'vitest'

// Control platform availability deterministically across OSes.
const isTerminalAvailable = vi.fn(() => true)
vi.mock('../../../../src/main/services/ai-terminal', () => ({
  isTerminalAvailable: () => isTerminalAvailable(),
}))

import {
  buildDisabledCapabilitiesGuidance,
  buildUnconfiguredCapabilitiesGuidance,
} from '../../../../src/main/apps/runtime/prompt/capabilities'

type TestApp = Parameters<typeof buildDisabledCapabilitiesGuidance>[0]

/** Minimal app whose only opted-out capabilities are the given permission ids. */
function makeApp(denied: string[]): TestApp {
  return {
    permissions: { granted: [], denied },
    spec: {},
  } as unknown as TestApp
}

/** App with the given capabilities explicitly turned ON (granted). */
function makeAppGranted(granted: string[]): TestApp {
  return {
    permissions: { granted, denied: [] },
    spec: {},
  } as unknown as TestApp
}

describe('buildDisabledCapabilitiesGuidance', () => {
  it('returns null when nothing is disabled (default all-on)', () => {
    expect(buildDisabledCapabilitiesGuidance(makeApp([]))).toBeNull()
  })

  it('lists a denied capability by its panel label and points to Capabilities', () => {
    const out = buildDisabledCapabilitiesGuidance(makeApp(['ai-browser']))
    expect(out).toContain('AI Browser')
    expect(out).toContain('Settings → Capabilities')
    // Must NOT reference the space-chat toolset broker location.
    expect(out).not.toMatch(/input area/i)
    expect(out).not.toMatch(/bottom-left/i)
  })

  it('lists every denied toggleable capability', () => {
    const out = buildDisabledCapabilitiesGuidance(makeApp(['ai-browser', 'email', 'im-push']))
    expect(out).toContain('AI Browser')
    expect(out).toContain('Email')
    expect(out).toContain('IM Push')
  })

  it('includes AI Terminal when denied on a platform that supports terminals', () => {
    isTerminalAvailable.mockReturnValue(true)
    const out = buildDisabledCapabilitiesGuidance(makeApp(['ai-terminal']))
    expect(out).toContain('AI Terminal')
  })

  it('omits AI Terminal when the platform cannot run terminals', () => {
    isTerminalAvailable.mockReturnValue(false)
    // Terminal is the only denied capability → whole fragment collapses to null.
    expect(buildDisabledCapabilitiesGuidance(makeApp(['ai-terminal']))).toBeNull()
    isTerminalAvailable.mockReturnValue(true)
  })

  it('never lists always-on capabilities even if named in denied', () => {
    // web-search / memory / ocr are not toggleable; denying them is a no-op here.
    const out = buildDisabledCapabilitiesGuidance(makeApp(['web-search', 'ocr', 'memory']))
    expect(out).toBeNull()
  })
})

describe('buildUnconfiguredCapabilitiesGuidance', () => {
  it('returns null when enabled capabilities are all configured', () => {
    const out = buildUnconfiguredCapabilitiesGuidance(makeApp([]), {
      emailChannelConfigured: true,
      imContactsAvailable: true,
    })
    expect(out).toBeNull()
  })

  it('flags Email when the toggle is ON but no email channel is configured', () => {
    const out = buildUnconfiguredCapabilitiesGuidance(makeApp([]), {
      emailChannelConfigured: false,
      imContactsAvailable: true,
    })
    expect(out).toContain('Email')
    expect(out).toContain('Settings → Message Channels')
    expect(out).not.toContain('IM Push')
  })

  it('flags IM Push when the toggle is ON but no contact is connected', () => {
    const out = buildUnconfiguredCapabilitiesGuidance(makeApp([]), {
      emailChannelConfigured: true,
      imContactsAvailable: false,
    })
    expect(out).toContain('IM Push')
    expect(out).toContain('notify_bot')
    expect(out).not.toContain('- Email')
  })

  it('flags both when neither is configured', () => {
    const out = buildUnconfiguredCapabilitiesGuidance(makeApp([]), {
      emailChannelConfigured: false,
      imContactsAvailable: false,
    })
    expect(out).toContain('Email')
    expect(out).toContain('IM Push')
  })

  it('does not flag a capability that is turned OFF (that is disabled-guidance territory)', () => {
    // Email denied → its absence is a disabled capability, not an unconfigured one.
    const out = buildUnconfiguredCapabilitiesGuidance(makeApp(['email', 'im-push']), {
      emailChannelConfigured: false,
      imContactsAvailable: false,
    })
    expect(out).toBeNull()
  })

  it('respects explicit grants the same as defaults', () => {
    const out = buildUnconfiguredCapabilitiesGuidance(makeAppGranted(['email']), {
      emailChannelConfigured: false,
      imContactsAvailable: true,
    })
    expect(out).toContain('Email')
  })
})
