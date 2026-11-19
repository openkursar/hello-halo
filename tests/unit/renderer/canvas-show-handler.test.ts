/**
 * This client's part of the AI's request to show something. The tab is always
 * made sure of; the screen switches only for the conversation this client is
 * showing to someone who is not typing, and never to a page a remote client
 * cannot display. Whatever this client did is what it answers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasShowRequest } from '../../../src/shared/types/canvas-show'

const env = vi.hoisted(() => ({
  electron: true, view: 'space', spaceId: 'space-1', viewed: 'conv-1' as string | null, typing: false,
  isOpen: false, activeTabId: null as string | null, kept: true, visible: true, focused: true,
}))
let listener: (request: CanvasShowRequest) => void = () => {}
const unlisten = vi.fn()
const reply = vi.fn(async (_r: unknown) => ({ success: true }))
const lifecycle = {
  ensureAIWorkTab: vi.fn((_space: string, _item: unknown): string | null => 'tab-ai'),
  ensureFileTab: vi.fn((_space: string, _path: string, _presenting: boolean): string | null => 'tab-file'),
  getCurrentSpaceId: vi.fn(() => env.spaceId),
  getIsOpen: vi.fn(() => env.isOpen),
  getActiveTabId: vi.fn(() => env.activeTabId),
  hasSpaceTab: vi.fn(() => env.kept),
  getTab: vi.fn(() => ({ browserViewId: 'v1', type: 'markdown', isLoading: false })),
  switchTab: vi.fn(async (id: string, options: { open: boolean }) => {
    env.activeTabId = id
    env.isOpen = options.open
  }),
}
vi.mock('../../../src/renderer/api', () => ({
  api: {
    onCanvasShowRequest: (cb: typeof listener) => { listener = cb; return unlisten },
    replyCanvasShow: (r: unknown) => reply(r),
  },
}))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.electron }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: { getState: () => ({ view: env.view }) } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: { getState: () => ({}) },
  selectActiveConversationId: () => env.viewed,
}))
vi.mock('../../../src/renderer/browser-host', () => ({ presentedBrowserPage: () => env.visible ? {} : undefined }))
vi.mock('../../../src/renderer/stores/chat/active', () => ({ selectViewedConversationId: () => env.viewed }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: lifecycle }))
vi.mock('../../../src/renderer/services/typing-activity', () => ({ isUserTyping: () => env.typing }))

const { presentCanvasShow, startCanvasShowHandler } = await import('../../../src/renderer/services/canvas-show-handler')

const request = (target: CanvasShowRequest['target'], extra: Partial<CanvasShowRequest> = {}): CanvasShowRequest => ({
  requestId: 'r1', replyWithinMs: 100, spaceId: 'space-1', conversationId: 'conv-1', target, bringForward: true, ...extra,
})
const page = { kind: 'page', viewId: 'v1', url: 'https://example.com', title: 'Example' } as const
const terminal = { kind: 'terminal', sessionId: 't1', title: 'build' } as const
const file = { kind: 'file', path: '/w/report.md' } as const

beforeEach(() => {
  Object.assign(env, { electron: true, view: 'space', spaceId: 'space-1', viewed: 'conv-1', typing: false, isOpen: false, activeTabId: null, kept: true, visible: true, focused: true })
  vi.stubGlobal('CSS', { escape: (id: string) => id })
  vi.stubGlobal('document', {
    hidden: false,
    hasFocus: () => env.focused,
    querySelector: (selector: string) => env.visible && selector.endsWith('[data-canvas-content-ready="true"]')
      ? { getClientRects: () => [{}] }
      : null,
  })
  Object.values(lifecycle).forEach(fn => fn.mockClear())
  lifecycle.ensureAIWorkTab.mockReturnValue('tab-ai')
  lifecycle.ensureFileTab.mockReturnValue('tab-file')
  reply.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('showing to someone looking at the conversation', () => {
  it('opens the canvas on the tab', async () => {
    expect(await presentCanvasShow(request(page))).toBe('shown')
    expect(lifecycle.ensureAIWorkTab).toHaveBeenCalledWith('space-1', expect.objectContaining({ kind: 'page', viewId: 'v1' }))
    expect(lifecycle.switchTab).toHaveBeenCalledWith('tab-ai', { open: true })
  })

  it('does the same for a terminal and for a file', async () => {
    expect(await presentCanvasShow(request(terminal))).toBe('shown')
    expect(lifecycle.ensureAIWorkTab).toHaveBeenCalledWith('space-1', expect.objectContaining({ kind: 'terminal', sessionId: 't1' }))
    expect(await presentCanvasShow(request(file))).toBe('shown')
    expect(lifecycle.ensureFileTab).toHaveBeenCalledWith('space-1', '/w/report.md', true)
    expect(lifecycle.switchTab).toHaveBeenLastCalledWith('tab-file', { open: true })
  })

  it('moves nothing when the tab is already what they are looking at', async () => {
    env.isOpen = true
    env.activeTabId = 'tab-ai'
    expect(await presentCanvasShow(request(page))).toBe('shown')
    expect(lifecycle.switchTab).not.toHaveBeenCalled()
  })
})

describe('keeping the screen where it is', () => {
  it('only keeps the tab while the user is typing', async () => {
    env.typing = true
    expect(await presentCanvasShow(request(page))).toBe('added')
    expect(lifecycle.ensureAIWorkTab).toHaveBeenCalled()
    expect(lifecycle.switchTab).not.toHaveBeenCalled()
    expect(env.isOpen).toBe(false)
  })

  it.each([
    ['another conversation is on screen', () => { env.viewed = 'conv-2' }],
    ['no conversation is really being viewed (window hidden or unfocused)', () => { env.viewed = null }],
    ['another workspace is shown', () => { env.spaceId = 'space-2' }],
    ['the user is on another page of Halo', () => { env.view = 'settings' }],
  ])('only keeps the tab when %s', async (_name, arrange) => {
    arrange()
    expect(await presentCanvasShow(request(terminal))).toBe('added')
    expect(lifecycle.ensureAIWorkTab).toHaveBeenCalledWith('space-1', expect.anything())
    expect(lifecycle.switchTab).not.toHaveBeenCalled()
    expect(env.isOpen).toBe(false)
  })

  it('only keeps the tab when this target was already brought forward in the reply', async () => {
    expect(await presentCanvasShow(request(file, { bringForward: false }))).toBe('added')
    expect(lifecycle.switchTab).not.toHaveBeenCalled()
  })

  it('still reports it as shown when it is already in front and the reply is a repeat', async () => {
    env.isOpen = true
    env.activeTabId = 'tab-file'
    expect(await presentCanvasShow(request(file, { bringForward: false }))).toBe('shown')
  })

  it('never switches a remote client to a page it cannot display, but does for other targets', async () => {
    env.electron = false
    expect(await presentCanvasShow(request(page))).toBe('added')
    expect(lifecycle.switchTab).not.toHaveBeenCalled()
    expect(await presentCanvasShow(request(terminal))).toBe('shown')
  })

  it('does not count a selected remote placeholder as shown', async () => {
    Object.assign(env, { electron: false, isOpen: true, activeTabId: 'tab-ai' })
    expect(await presentCanvasShow(request(page))).toBe('added')
    expect(lifecycle.switchTab).not.toHaveBeenCalled()
  })

  it('does not claim to have kept a tab in a removed workspace or one the budget refused', async () => {
    lifecycle.ensureAIWorkTab.mockReturnValue(null)
    expect(await presentCanvasShow(request(page))).toBe('unavailable')
    lifecycle.ensureFileTab.mockReturnValue(null)
    expect(await presentCanvasShow(request(file))).toBe('unavailable')
    expect(lifecycle.switchTab).not.toHaveBeenCalled()
  })

  it('does not claim visibility when the preview never becomes visible', async () => {
    env.visible = false
    expect(await presentCanvasShow(request(page))).toBe('opened')
  })

  it('does not count a mounted file viewer whose preview did not render', async () => {
    env.visible = false
    expect(await presentCanvasShow(request(file))).toBe('opened')
  })

  it('does not open the newly selected workspace or confirm visibility there', async () => {
    lifecycle.switchTab.mockImplementationOnce(async () => {
      env.spaceId = 'space-2'
      env.isOpen = false
    })
    expect(await presentCanvasShow(request(file))).toBe('opened')
    expect(env.isOpen).toBe(false)
  })

  it('does not confirm a tab that disappeared during the switch', async () => {
    lifecycle.switchTab.mockImplementationOnce(async () => { env.kept = false })
    expect(await presentCanvasShow(request(file))).toBe('unavailable')
  })
})

describe('answering the request', () => {
  it('replies with what this client did, under the request\'s id', async () => {
    const stop = startCanvasShowHandler()
    listener(request(page))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ requestId: 'r1', outcome: 'shown' }))
    stop()
    expect(unlisten).toHaveBeenCalled()
  })

  it('still answers, as only added, when showing failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    lifecycle.switchTab.mockRejectedValueOnce(new Error('boom'))
    startCanvasShowHandler()
    listener(request(page))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ requestId: 'r1', outcome: 'added' }))
  })

  it('does not throw when the answer cannot be delivered', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    reply.mockRejectedValueOnce(new Error('offline'))
    startCanvasShowHandler()
    listener(request(page))
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
  })
})
