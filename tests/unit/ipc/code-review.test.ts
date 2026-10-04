/**
 * The review buttons' transport: every contract channel is registered over
 * IPC, the remote routes answer the same, and a malformed request never
 * reaches the review service — a revision that looks like an option least of
 * all, since it would end up in the review prompt's git commands.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import { codeReviewRpc } from '../../../src/shared/rpc/contracts/code-review.contract'
import type { CodeReviewStartRequest } from '../../../src/shared/types/code-review'
import type { GitReviewRecord } from '../../../src/shared/types/git'

type Handler = (event: unknown, ...args: unknown[]) => Promise<{ success: boolean; data?: any; error?: string }>
const { handlers, service } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  service: {
    startReview: vi.fn(),
    getLatestReview: vi.fn(),
    getReviewAvailability: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn), on: vi.fn() },
  shell: { trashItem: vi.fn() },
}))
vi.mock('../../../src/main/services/code-review', () => service)
vi.mock('../../../src/main/services/space.service', () => ({ getSpaceDir: () => '' }))

const { registerCodeReviewHandlers } = await import('../../../src/main/ipc/code-review')
const { registerCodeReviewRoutes } = await import('../../../src/main/http/routes/code-review.routes')
registerCodeReviewHandlers()

const RECORD: GitReviewRecord = {
  repoRoot: '/work/app',
  conversationId: 'conv-1',
  variant: 'quick',
  scope: { kind: 'uncommitted' },
  scopeLabel: 'Uncommitted changes',
  snapshot: 'a'.repeat(40),
  fileCount: 2,
  startedAt: 1,
}

function request(overrides: Partial<Record<keyof CodeReviewStartRequest, unknown>> = {}): Record<string, unknown> {
  return {
    spaceId: 'space-1',
    repoRoot: '/work/app',
    variant: 'quick',
    scope: { kind: 'revision', revision: 'origin/main', mergeBase: true },
    scopeLabel: 'Compared with origin/main',
    fileCount: 2,
    language: 'zh-CN',
    title: 'Review · Uncommitted changes · 2 files',
    ...overrides,
  }
}

async function http(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const app = express()
  app.use(express.json())
  registerCodeReviewRoutes(app)
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return await res.json()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  service.startReview.mockResolvedValue({ ok: true, conversationId: 'conv-1', record: RECORD })
  service.getLatestReview.mockReturnValue(RECORD)
  service.getReviewAvailability.mockReturnValue({ team: { available: true } })
})

describe('code-review transport', () => {
  it('registers every contract channel over IPC', () => {
    expect([...handlers.keys()].sort()).toEqual(Object.values(codeReviewRpc).map((method) => method.channel).sort())
  })

  it('starts a review with the checked request, title trimmed and capped', async () => {
    const long = `  ${'x'.repeat(300)}  `
    const res = await handlers.get('code-review:start')!({}, request({ title: long }))
    expect(res).toEqual({ success: true, data: { ok: true, conversationId: 'conv-1', record: RECORD } })
    expect(service.startReview).toHaveBeenCalledWith({ ...request(), title: 'x'.repeat(200) })
  })

  it('refuses malformed requests before the service sees them', async () => {
    for (const bad of [
      request({ variant: 'deep' }),
      request({ scope: { kind: 'revision', revision: '--output=/tmp/x', mergeBase: false } }),
      request({ scope: { kind: 'since-review', snapshot: 'HEAD' } }),
      request({ fileCount: -1 }),
      request({ title: '   ' }),
      request({ spaceId: 42 }),
      null,
    ]) {
      expect((await handlers.get('code-review:start')!({}, bad)).success).toBe(false)
    }
    expect(service.startReview).not.toHaveBeenCalled()
  })

  it('answers the same over HTTP', async () => {
    expect(await http('POST', '/api/code-review/start', request())).toEqual({
      success: true,
      data: { ok: true, conversationId: 'conv-1', record: RECORD },
    })
    const query = `spaceId=space-1&repoRoot=${encodeURIComponent('/work/app')}`
    expect(await http('GET', `/api/code-review/latest?${query}`)).toEqual({ success: true, data: RECORD })
    expect(service.getLatestReview).toHaveBeenCalledWith('space-1', '/work/app')
    expect(await http('GET', '/api/code-review/latest?spaceId=space-1')).toMatchObject({ success: false })
    expect(await http('GET', '/api/code-review/availability')).toEqual({ success: true, data: { team: { available: true } } })
    expect(await handlers.get('code-review:get-latest')!({}, 'space-1', '/work/app')).toEqual({ success: true, data: RECORD })
  })
})
