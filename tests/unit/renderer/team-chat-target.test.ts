/**
 * Which digital human a team conversation opens onto.
 *
 * The rule has to survive two things that actually happen: you brought several
 * and expect the one you last used, and a member row outliving its app (the app
 * was uninstalled, the profile was reset) — a remembered choice that can no
 * longer answer must fall through instead of pointing the chat at nothing.
 */

import { describe, it, expect } from 'vitest'
import { pickChatTarget } from '../../../src/renderer/stores/team-view-prefs.store'

const ARCHITECT = 'app-architect'
const PM = 'app-pm'
const LEAD = 'app-lead'

describe('team conversation target', () => {
  it('opens onto the first one you brought when you have never chosen', () => {
    expect(pickChatTarget(undefined, [ARCHITECT, PM], LEAD)).toBe(ARCHITECT)
  })

  it('opens onto the one you last chose', () => {
    expect(pickChatTarget(PM, [ARCHITECT, PM], LEAD)).toBe(PM)
  })

  it('falls through when the one you chose can no longer answer', () => {
    expect(pickChatTarget(PM, [ARCHITECT], LEAD)).toBe(ARCHITECT)
  })

  it('falls back to the lead only when you brought nobody', () => {
    expect(pickChatTarget(undefined, [], LEAD)).toBe(LEAD)
    expect(pickChatTarget(PM, [], LEAD)).toBe(LEAD)
  })

  it('never prefers the lead over one of your own', () => {
    expect(pickChatTarget(undefined, [ARCHITECT], LEAD)).not.toBe(LEAD)
  })

  it('reports nobody to talk to rather than guessing', () => {
    expect(pickChatTarget(undefined, [], null)).toBeNull()
  })
})
