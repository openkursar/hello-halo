/**
 * Where report_to_user tells the agent to write files, and what it records as
 * the entry's data_path, depends on the deployment: a server user can only
 * reach files inside the space, while the desktop can open any local path and
 * keeps its original behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { toolMock, createSdkMcpServerMock } = vi.hoisted(() => ({
  toolMock: vi.fn((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler,
  })),
  createSdkMcpServerMock: vi.fn((opts: any) => ({ name: opts.name, tools: opts.tools })),
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: toolMock,
  createSdkMcpServer: createSdkMcpServerMock,
}))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/services/notification.service', () => ({ notifyAppEvent: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/team', () => ({ getActiveTeamRuntime: vi.fn(() => null) }))
vi.mock('../../../../src/main/apps/runtime/im-escalation', () => ({ deliverEscalationToIm: vi.fn() }))

const { isServerMode, resolveReportFile } = vi.hoisted(() => ({
  isServerMode: vi.fn(() => false),
  resolveReportFile: vi.fn(async () => '/spaces/s1/outputs/plan.md'),
}))
vi.mock('../../../../src/main/foundation/runtime-mode', () => ({ isServerMode }))
vi.mock('../../../../src/main/apps/runtime/report-output', async original => ({
  ...await original<typeof import('../../../../src/main/apps/runtime/report-output')>(), resolveReportFile,
}))

import { createReportToolServer } from '../../../../src/main/apps/runtime/report-tool'
import type { ReportToolContext } from '../../../../src/main/apps/runtime/report-tool'
import type { ActivityEntry } from '../../../../src/main/apps/runtime/types'

const ctx: ReportToolContext = {
  appId: 'app-1',
  appName: 'App',
  runId: 'run-1',
  sessionKey: 'app:app-1:run-1',
  workDir: '/spaces/s1',
  plansDir: '/config/plans',
}

function build() {
  const entries: ActivityEntry[] = []
  const store = {
    insertEntry: vi.fn((e: ActivityEntry) => entries.push(e)),
    getAllPendingEscalations: vi.fn(() => []),
  } as any
  createReportToolServer(store, ctx)
  const [, description, , handler] = toolMock.mock.calls[toolMock.mock.calls.length - 1]
  return { entries, description: description as string, handler: handler as (input: any) => Promise<any> }
}

describe('report_to_user file location', () => {
  beforeEach(() => {
    toolMock.mockClear()
    resolveReportFile.mockClear()
  })

  it('desktop keeps the plans directory and the reported path as given', async () => {
    isServerMode.mockReturnValue(false)
    const { entries, description, handler } = build()

    expect(description).toContain('By default, write files to: /config/plans')
    expect(description).not.toContain('/spaces/s1/outputs')

    await handler({ type: 'output', message: 'Plan ready', data_path: '/tmp/plan.md' })
    expect(resolveReportFile).not.toHaveBeenCalled()
    expect(entries[0].content.dataPath).toBe('/tmp/plan.md')
  })

  it('server names the output directory and records the validated file', async () => {
    isServerMode.mockReturnValue(true)
    const { entries, description, handler } = build()

    expect(description).toContain('Write report files under: /spaces/s1/outputs')
    expect(description).not.toContain('/config/plans')

    await handler({ type: 'output', message: 'Plan ready', data_path: 'outputs/plan.md' })
    expect(resolveReportFile).toHaveBeenCalledWith('outputs/plan.md', '/spaces/s1', undefined)
    expect(entries[0].content.dataPath).toBe('/spaces/s1/outputs/plan.md')
  })

  it('refuses a bad file before publishing any result or finishing the run', async () => {
    isServerMode.mockReturnValue(true)
    resolveReportFile.mockRejectedValueOnce(new Error('Write a report in the workspace.'))
    const { entries, handler } = build()
    const result = await handler({ type: 'run_complete', message: 'Report', data_path: 'gone.md' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('workspace')
    expect(entries).toEqual([])
  })
})
