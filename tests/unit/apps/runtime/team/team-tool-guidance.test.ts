import { describe, it, expect, vi } from 'vitest'
import { createCollaborationServer, type CollaborationResult } from '@hello-halo/agent-sdk/collaboration'

vi.mock('../../../../../src/main/services/agent/resolved-sdk', async () =>
  import('../../../../../src/main/services/agent/mcp/sdk-server'))

import { createCoordinationMcpServer } from '../../../../../src/main/apps/runtime/team/team-tools'

const server = createCoordinationMcpServer(() => null, {
  spawn: async () => ({ content: [{ type: 'text', text: 'created' }] }),
})
const tools = server.instance.listTools()
const find = (name: string) => tools.find(tool => tool.name === name)!

describe('shared collaboration contract', () => {
  it('offers the same nine tools and schemas as the standalone SDK', () => {
    const operations = Object.fromEntries(tools.map(tool => [tool.name, async () => ({ content: [] })]))
    expect(tools).toEqual(createCollaborationServer(operations).instance.listTools())
    expect(tools.map(tool => tool.name)).toEqual([
      'spawn_agent', 'team_send', 'team_read_board', 'team_read_member', 'team_post_finding',
      'team_read_artifact', 'team_post_task', 'team_update_task', 'team_stop',
    ])
  })

  it('creates one collaborator with an assignment and permits incremental additions without group selection', () => {
    expect(find('spawn_agent').inputSchema).toMatchObject({
      required: ['prompt'], additionalProperties: false,
      properties: { prompt: { type: 'string' }, name: { type: 'string' } },
    })
    expect(Object.keys(find('spawn_agent').inputSchema!.properties as object)).toEqual(['prompt', 'name', 'cwd', 'isolation'])
    expect(find('spawn_agent').description).toContain('create more collaborators as needed')
    expect(find('spawn_agent').description).toContain('No team setup or shared goal is required')
  })

  it('distinguishes delivery, board tracking and reusable findings', () => {
    expect(find('team_send').description).toContain('Returns delivery status, not task completion')
    expect(find('team_post_task').description).toContain('does not notify or start the assignee')
    expect(find('team_post_finding').description).toContain('Do not use this for assignments')
    expect(find('team_post_finding').description).toContain('only one collaborator')
    expect(find('team_stop').description).toContain('does not mark work complete')
  })

  it('describes fact checking and the remote artifact boundary at the point of use', () => {
    expect(find('team_read_board').description).toContain('not for repeated progress polling')
    expect(find('team_read_member').description).toContain('not private reasoning')
    expect(find('team_read_artifact').description).toContain('including one produced on another machine')
  })

  it('points an empty conversation to the incremental creation tool', async () => {
    const reply = await server.instance.callTool('team_send', { to: 'missing', message: 'Hello' }) as CollaborationResult
    expect(reply).toMatchObject({ isError: true })
    expect(reply!.content[0]).toMatchObject({ text: expect.stringContaining('Use spawn_agent') })
  })

  it('rejects management and scope arguments before any operation', async () => {
    expect(await server.instance.callTool('collab_start', {})).toBeUndefined()
    for (const input of [{ prompt: 'Review', team_id: 'foreign' }, { prompt: 'Review', goal: 'new' }, { prompt: 'Review', model: 'unknown' }]) {
      expect(await server.instance.callTool('spawn_agent', input)).toMatchObject({ isError: true })
    }
  })
})
