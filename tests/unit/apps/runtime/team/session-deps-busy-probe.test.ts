/**
 * Regression test for the busy probe the team runtime hands to the turn gate.
 *
 * The bug this pins shipped silently and was invisible to every other test in
 * the suite: `createDefaultSessionDeps().isSessionActive` read the legacy
 * `activeSessions` map, which app chat never writes (it runs on the consumer
 * model), so the probe answered `false` for every team session that had ever
 * run. Nothing failed loudly — the gate's reservation still queued mail
 * correctly — so the only effect was that everything the probe exists FOR
 * quietly did not happen: mid-turn delivery refused on "no turn is streaming",
 * quiescence counting a streaming member as idle, and the slot watchdog willing
 * to reclaim a session mid-stream.
 *
 * Every layer test passed throughout, because they all inject their own
 * `isSessionActive`. Only the real wiring was wrong, so only a test of the real
 * wiring can catch it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { generating } = vi.hoisted(() => ({ generating: new Set<string>() }))

vi.mock('../../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: (conversationId: string) => generating.has(conversationId),
  injectIntoAppChat: () => true,
}))

vi.mock('../../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: () => ({ spaceId: 'space-1' }) }),
}))

import { createDefaultSessionDeps } from '../../../../../src/main/apps/runtime/team'
import type { TeamStore } from '../../../../../src/main/apps/team'

const SESSION_KEY = 'app-chat:app-lead:team:team-1:epoch-1'

describe('createDefaultSessionDeps — the busy probe', () => {
  beforeEach(() => {
    generating.clear()
  })

  it('follows the turn in both directions, not just into busy', () => {
    // The probe feeds the gate, and the gate's two safety behaviors read
    // opposite sides of it: while it is true the watchdog refuses to reclaim a
    // slot, and only once it is false does anything drain into that session or
    // seal the run it belongs to. A wiring that latched true would look correct
    // in every "is it busy" test and quietly stop runs from ever ending.
    const deps = createDefaultSessionDeps({} as TeamStore)

    expect(deps.isSessionActive(SESSION_KEY)).toBe(false)
    generating.add(SESSION_KEY)
    expect(deps.isSessionActive(SESSION_KEY)).toBe(true)
    generating.delete(SESSION_KEY)
    expect(deps.isSessionActive(SESSION_KEY)).toBe(false)
  })

  it('answers per session, so one member being busy says nothing about another', () => {
    const deps = createDefaultSessionDeps({} as TeamStore)
    generating.add(SESSION_KEY)

    expect(deps.isSessionActive('app-chat:app-other:team:team-1:epoch-1')).toBe(false)
  })
})
