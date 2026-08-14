/**
 * The circuit breaker's `maxForwardDepth` is the only guard against two members
 * messaging each other forever, and it counts a chain: a member's own send must
 * inherit the depth of the turn it is sending from, or every hop restarts at 0
 * and the limit is never reached.
 *
 * The SDK's tool() wrapper is mocked to expose the handler directly; the bus is
 * a stub because the assertion is about what the tool hands it.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
  createSdkMcpServer: (options: { tools: Array<{ name: string }> }) => options,
}))

import { createTeamMcpServer } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { TeamMcpContext } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { MessageBus, SendInput } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { Blackboard } from '../../../../../src/main/apps/runtime/team/blackboard'
import { TEAM_TOOL_NAMES } from '../../../../../src/shared/apps/team-types'

type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function callSend(ctxOverrides: Partial<TeamMcpContext>): {
  sends: SendInput[]
  call: () => Promise<ToolReply>
} {
  const sends: SendInput[] = []
  const bus = {
    resolveMemberAppId: () => 'app-researcher',
    assertCanContact: () => {},
    send: async (input: SendInput) => {
      sends.push(input)
      return { messageId: 'm1' }
    },
  } as unknown as MessageBus

  const ctx: TeamMcpContext = {
    teamId: 'team-1',
    epochId: 'epoch-1',
    callerAppId: 'app-lead',
    collabMode: 'free',
    selfIsLead: true,
    bus,
    blackboard: {} as Blackboard,
    callerWorkDir: '/tmp',
    requestComplete: () => {},
    ...ctxOverrides,
  }

  const server = createTeamMcpServer(ctx) as unknown as {
    tools: Array<{ name: string; handler: (input: Record<string, unknown>) => Promise<ToolReply> }>
  }
  const found = server.tools.find((t) => t.name === TEAM_TOOL_NAMES.send)!
  return { sends, call: () => found.handler({ to: 'researcher', message: 'go' }) }
}

describe('team_send forward depth', () => {
  it('inherits the depth of the turn it is sent from', async () => {
    const { sends, call } = callSend({ forwardDepth: 3 })
    await call()
    expect(sends[0].forwardDepth).toBe(3)
  })

  it('is undefined for a turn with no chain behind it', async () => {
    const { sends, call } = callSend({})
    await call()
    expect(sends[0].forwardDepth).toBeUndefined()
  })
})
