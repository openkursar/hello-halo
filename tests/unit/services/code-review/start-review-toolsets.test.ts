/**
 * The tools a review conversation starts with, read from the real toolset
 * state over a real conversation record. A new conversation inherits the
 * user's last-used set, which may hold the team tools either way; the first
 * message's session is seeded from whatever the review left open.
 *
 * Only IO boundaries (disk, space registry, config) and heavy server factories
 * are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  config: { agent: {}, lastToolsets: [] as string[] },
  saveConfig: vi.fn(),
  toolsets: ['halo-team', 'ai-browser'],
  seeded: [] as string[][],
}))

vi.mock('fs', () => {
  const files = new Map<string, string>()
  return {
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      const data = files.get(p)
      if (data === undefined) throw new Error(`ENOENT: ${p}`)
      return data
    },
    writeFileSync: (p: string, data: string) => { files.set(p, data) },
    mkdirSync: () => undefined,
    readdirSync: (p: string) => [...files.keys()].filter(k => k.startsWith(p)).map(k => k.split('/').pop() as string),
    rmSync: (p: string) => { files.delete(p) },
    renameSync: (from: string, to: string) => {
      const data = files.get(from)
      if (data === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, data)
    },
  }
})
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (spaceId: string) => ({ id: spaceId, path: `/spaces/${spaceId}`, isTemp: false }),
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => m.config, saveConfig: m.saveConfig }))

vi.mock('../../../../src/main/services/web-search', () => ({ createWebSearchMcpServer: () => ({}) }))
vi.mock('../../../../src/main/services/app-bridge', () => ({ createHaloAppsMcpServer: () => ({}) }))
vi.mock('../../../../src/main/services/official-docs-mcp', () => ({
  createOfficialDocsSession: () => ({ server: {}, guideConsulted: () => false }),
}))
vi.mock('../../../../src/main/services/ai-browser', () => ({ releaseInteractiveBrowserContext: () => undefined }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/toolsets/meta-server', () => ({
  createBrokerMetaServer: () => ({}),
  CAPABILITIES_SERVER_NAME: 'capabilities',
}))
vi.mock('../../../../src/main/services/agent/toolsets/registry', () => ({
  getAvailableToolsets: () => m.toolsets.map(id => ({ id })),
  getToolset: (id: string) => (m.toolsets.includes(id) ? { id, createServer: () => ({ id }) } : undefined),
}))

// The engine's surface, wired to the real broker. Sending the first message is
// where the session is created, so that is when its seed is taken.
vi.mock('../../../../src/main/services/agent', async () => {
  const broker = await vi.importActual<typeof import('../../../../src/main/services/agent/toolsets/broker')>(
    '../../../../src/main/services/agent/toolsets/broker',
  )
  const { getToolset } = await import('../../../../src/main/services/agent/toolsets/registry')
  return {
    ...(await vi.importActual<object>('../../../../src/main/services/agent/prompt-text')),
    getToolset,
    openToolset: broker.openToolset,
    closeToolset: broker.closeToolset,
    getWorkingDir: (spaceId: string) => `/spaces/${spaceId}`,
    sendMessage: async ({ spaceId, conversationId }: { spaceId: string; conversationId: string }) => {
      m.seeded.push(Object.keys(broker.buildCreationTimeServers({ spaceId, conversationId, workDir: `/spaces/${spaceId}` })))
    },
  }
})

vi.mock('../../../../src/main/services/git', () => ({
  resolveRepository: async () => ({ root: '/spaces/space-1/repo', name: 'repo' }),
  createSnapshot: async () => ({ tree: 'a'.repeat(40), createdAt: 1000 }),
  getChangeList: async () => ({
    scope: { kind: 'uncommitted' },
    beforeRevision: 'b'.repeat(40),
    files: [{ path: 'src/a.ts', state: 'modified', additions: 1, deletions: 0, binary: false }],
    truncated: false,
  }),
  isGitError: () => false,
}))
vi.mock('../../../../src/main/services/code-review/review-store', () => ({ saveLatestReview: vi.fn() }))

import { startReview } from '../../../../src/main/services/code-review/start-review'
import { getConversation } from '../../../../src/main/services/conversation.service'
import type { CodeReviewStartRequest } from '../../../../src/shared/types/code-review'

const SPACE = 'space-1'

async function start(variant: CodeReviewStartRequest['variant']): Promise<string> {
  const result = await startReview({
    spaceId: SPACE,
    repoRoot: '/spaces/space-1/repo',
    variant,
    scope: { kind: 'uncommitted' },
    scopeLabel: 'Uncommitted changes',
    fileCount: 1,
    language: 'en',
    title: 'Review',
  })
  if (!result.ok) throw new Error(result.message)
  return result.conversationId
}

beforeEach(() => {
  m.seeded.length = 0
  m.saveConfig.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('the toolsets a review conversation starts with', () => {
  it('leaves the team tools out of a quick review, though the user last had them on', async () => {
    m.config.lastToolsets = ['halo-team', 'ai-browser']
    const conversationId = await start('quick')

    expect(getConversation(SPACE, conversationId)?.toolsets).toEqual(['ai-browser'])
    expect(m.seeded).toHaveLength(1)
    expect(m.seeded[0]).toContain('ai-browser')
    expect(m.seeded[0]).not.toContain('halo-team')
    // The user's own last-used set is not rewritten by a review.
    expect(m.saveConfig).not.toHaveBeenCalled()
  })

  it('gives a team review the team tools, though the user last had them off', async () => {
    m.config.lastToolsets = []
    const conversationId = await start('team')

    expect(getConversation(SPACE, conversationId)?.toolsets).toEqual(['halo-team'])
    expect(m.seeded).toHaveLength(1)
    expect(m.seeded[0]).toContain('halo-team')
    expect(m.saveConfig).not.toHaveBeenCalled()
  })
})
