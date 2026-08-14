/**
 * Which digital human a team conversation opens onto.
 *
 * This pane speaks for the digital humans on THIS machine — the lead included
 * when it runs here, since it is then one of yours like any other. The rule has
 * to survive two things that actually happen: you brought several and expect the
 * one you last used, and a member row outliving its app (the app was
 * uninstalled, the profile was reset) — a remembered choice that can no longer
 * answer must fall through instead of pointing the chat at nothing.
 */

import { describe, it, expect } from 'vitest'
import { pickChatTarget } from '../../../src/renderer/stores/team-view-prefs.store'

const ARCHITECT = 'app-architect'
const PM = 'app-pm'
const LEAD = 'app-lead'

describe('team conversation target', () => {
  it('opens onto the first one you brought when you have never chosen', () => {
    expect(pickChatTarget(undefined, [ARCHITECT, PM])).toBe(ARCHITECT)
  })

  it('opens onto the one you last chose', () => {
    expect(pickChatTarget(PM, [ARCHITECT, PM])).toBe(PM)
  })

  it('falls through when the one you chose can no longer answer', () => {
    expect(pickChatTarget(PM, [ARCHITECT])).toBe(ARCHITECT)
  })

  it('keeps the lead when the lead is one of this machine\u2019s own', () => {
    expect(pickChatTarget(LEAD, [LEAD, ARCHITECT])).toBe(LEAD)
  })

  it('reports nobody to talk to rather than reaching for a teammate\u2019s', () => {
    expect(pickChatTarget(undefined, [])).toBeNull()
    expect(pickChatTarget(PM, [])).toBeNull()
  })
})
