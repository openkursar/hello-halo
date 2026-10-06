/**
 * The team tools a member is handed while it serves a guest of an IM chat it
 * fronts: the coordination channel stays (the guest's request may need a
 * teammate), periodic checks do not — a standing instruction keeps spending the
 * owner's model allowance long after the guest has gone.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (options: { tools: Array<{ name: string }> }) => options,
}))

import { createTeamMcpServer } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { TeamMcpContext } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { MessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { Blackboard } from '../../../../../src/main/apps/runtime/team/blackboard'
import { TEAM_TOOL_NAMES } from '../../../../../src/shared/apps/team-types'

function toolNames(overrides: Partial<TeamMcpContext>): string[] {
  const ctx: TeamMcpContext = {
    teamId: 't',
    epochId: 'e',
    callerAppId: 'app-desk',
    collabMode: 'free',
    selfIsLead: true,
    bus: {} as MessageBus,
    blackboard: {} as Blackboard,
    callerWorkDir: '/tmp',
    requestComplete: () => {},
    ...overrides,
  }
  return (createTeamMcpServer(ctx) as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
}

describe('team tools while serving a guest', () => {
  it('withholds setting and stopping periodic checks', () => {
    const names = toolNames({ servesGuest: true })
    expect(names).not.toContain(TEAM_TOOL_NAMES.schedule)
    expect(names).not.toContain(TEAM_TOOL_NAMES.unschedule)
  })

  it('keeps the coordination channel the request may need', () => {
    expect(toolNames({ servesGuest: true })).toEqual(
      expect.arrayContaining([TEAM_TOOL_NAMES.send, TEAM_TOOL_NAMES.postTask, TEAM_TOOL_NAMES.readBoard])
    )
  })

  it('leaves every other turn its periodic checks', () => {
    expect(toolNames({})).toEqual(expect.arrayContaining([TEAM_TOOL_NAMES.schedule, TEAM_TOOL_NAMES.unschedule]))
  })
})
