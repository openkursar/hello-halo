/**
 * What the team tools say about themselves at the moment the model chooses
 * between them: posting a task does not reach the teammate, and a call made
 * with no agent team started points to the right next step.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (options: { tools: Array<{ name: string }> }) => options,
}))

import { createSpaceTeamMcpServer } from '../../../../../src/main/apps/conversation-mcp/team-mcp'
import { buildCoordinationTools } from '../../../../../src/main/apps/runtime/team/team-tools'
import { TEAM_TOOL_NAMES } from '../../../../../src/shared/apps/team-types'

type Tool = { name: string; description: string; handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }

const tools = buildCoordinationTools(() => null) as unknown as Tool[]
const spaceTools = (createSpaceTeamMcpServer({ spaceId: 's', conversationId: 'c', workDir: '/tmp' }) as unknown as { tools: Tool[] }).tools
const find = (name: string) => tools.find((tool) => tool.name === name)!

describe('team tool descriptions', () => {
  it('says that posting a task does not notify the teammate, and where to send the message instead', () => {
    expect(find(TEAM_TOOL_NAMES.postTask).description).toContain('it does not notify the teammate, so message them with team_send')
  })

  it('leaves when to read the board, a member\u2019s record or an artifact to the tools themselves', () => {
    expect(find(TEAM_TOOL_NAMES.readBoard).description).toContain('reconcile state')
    expect(find(TEAM_TOOL_NAMES.readMember).description).toContain('check work against what the member claims')
    expect(find(TEAM_TOOL_NAMES.readArtifact).description).toContain('open a deliverable a teammate shared')
  })
})

describe('the tools of a chat that can start an agent team', () => {
  const described = (name: string) => spaceTools.find((tool) => tool.name === name)!.description

  it('collab_start defaults to doing the work yourself and names the three reasons to separate a part', () => {
    const text = described('collab_start')
    expect(text).toContain('do the work yourself by default')
    expect(text).toContain('it keeps bulky details out of this chat, it can run in parallel with other parts, or it needs teammates to work with each other')
    expect(text).toContain('brief them with team_send')
    expect(text).not.toContain('team_post_task')
  })

  it('team_list no longer sends it to check for a standing team before starting an agent team', () => {
    expect(described('team_list')).toBe('List the standing teams of this space (id, members, status).')
  })

  it('team_run is for handing a job to a standing team the person asked for', () => {
    expect(described('team_run')).toContain('Only when the person asks to give the job to that team')
  })
})

describe('a team tool called with no agent team started in this chat', () => {
  it('says so, and sends a standing team\u2019s work to Operate Halo instead of to collab_start alone', async () => {
    const reply = await find(TEAM_TOOL_NAMES.readBoard).handler({})
    expect(reply.isError).toBe(true)
    expect(reply.content[0].text).toContain('No agent team has been started in this chat.')
    expect(reply.content[0].text).toContain('collab_start')
    expect(reply.content[0].text).toContain('for a standing team\'s work, use the Operate Halo calls in your instructions')
  })
})
