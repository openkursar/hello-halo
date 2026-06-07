/**
 * Unit tests for runtime/team/team-prompt — the IM front-desk bridge fragment.
 *
 * buildTeamImBridge is the Entry overlay used when a team LEAD serves an IM
 * channel (a team-backed IM instance). It must override the base team Entry's
 * "delivered by the runtime, not a human" framing: the message is from a real
 * person and the lead replies straight back to them in-chat.
 */

import { describe, it, expect } from 'vitest'
import { buildTeamImBridge } from '../../../../../src/main/apps/runtime/team/team-prompt'

describe('buildTeamImBridge', () => {
  const im = { channel: 'wecom-bot', displayName: 'Acme Sales Group', chatType: 'group' as const }

  it('frames the lead as the team front desk for the person', () => {
    const out = buildTeamImBridge(im)
    expect(out).toContain('Front Desk')
    expect(out).toContain('wecom-bot')
    expect(out).toContain('Acme Sales Group')
    expect(out).toContain('group')
    // Explicitly corrects the base team Entry framing.
    expect(out).toContain('NOT by the team runtime')
  })

  it('tells the lead its final message is the reply (no tool needed)', () => {
    const out = buildTeamImBridge(im)
    expect(out).toContain('final message')
    expect(out.toLowerCase()).toContain('do not call any tool to reply')
  })

  it('steers delegation toward wait=true so results land within the turn', () => {
    const out = buildTeamImBridge(im)
    expect(out).toContain('team_send')
    expect(out).toContain('wait=true')
    expect(out).toContain('wait=false')
  })

  it('reflects a direct chat type', () => {
    const out = buildTeamImBridge({ channel: 'weixin-ilink-bot', displayName: 'Jane', chatType: 'direct' })
    expect(out).toContain('direct')
    expect(out).toContain('Jane')
  })
})
