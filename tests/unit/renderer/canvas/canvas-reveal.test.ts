/**
 * Going back to a place in a canvas tab: a one-shot reveal request rides on
 * the tab until the viewer handles it, a repeat request for the same place is
 * distinct, and a stale consume never clears a newer request.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/renderer/api', () => ({
  api: {
    onBrowserStateChange: () => () => {},
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
    readArtifactContent: async () => ({ success: true, data: { content: 'one\ntwo\nthree' } }),
    retainArtifactSpace: async () => ({ success: true, data: { recreated: false } }),
    releaseArtifactSpace: async () => ({ success: true }),
  },
}))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')

const tabFor = (path: string) => canvasLifecycle.getTabs().find(tab => tab.path === path)

beforeEach(async () => {
  await canvasLifecycle.closeAll()
})

describe('reveal requests', () => {
  it('a new file tab carries the request until the viewer consumes it', async () => {
    const tabId = await canvasLifecycle.openFile('/repo/a.ts', { reveal: { range: { startLine: 2, endLine: 3 }, quote: 'two' } })
    const request = tabFor('/repo/a.ts')?.reveal
    expect(request).toMatchObject({ range: { startLine: 2, endLine: 3 }, quote: 'two' })
    canvasLifecycle.consumeReveal(tabId, request!.seq)
    expect(tabFor('/repo/a.ts')?.reveal).toBeUndefined()
  })

  it('asking again for an open file activates it with a fresh request', async () => {
    const tabId = await canvasLifecycle.openFile('/repo/a.ts')
    await canvasLifecycle.openFile('/repo/b.ts')
    await canvasLifecycle.openFile('/repo/a.ts', { reveal: { range: { startLine: 1, endLine: 1 } } })
    const first = tabFor('/repo/a.ts')!.reveal!
    expect(canvasLifecycle.getActiveTabId()).toBe(tabId)

    await canvasLifecycle.openFile('/repo/a.ts', { reveal: { range: { startLine: 1, endLine: 1 } } })
    const second = tabFor('/repo/a.ts')!.reveal!
    expect(second.seq).not.toBe(first.seq)
  })

  it('a stale consume leaves the newer request in place', async () => {
    const tabId = await canvasLifecycle.openFile('/repo/a.ts', { reveal: { quote: 'one' } })
    const stale = tabFor('/repo/a.ts')!.reveal!.seq
    await canvasLifecycle.revealInTab(tabId, { quote: 'three' })
    canvasLifecycle.consumeReveal(tabId, stale)
    expect(tabFor('/repo/a.ts')?.reveal).toMatchObject({ quote: 'three' })
  })

  it('still accepts a plain title, and opening without a reveal adds none', async () => {
    await canvasLifecycle.openFile('/repo/c.md', 'Notes')
    expect(tabFor('/repo/c.md')).toMatchObject({ title: 'Notes' })
    expect(tabFor('/repo/c.md')?.reveal).toBeUndefined()
  })

  it('revealInTab on a closed tab does nothing', async () => {
    await expect(canvasLifecycle.revealInTab('missing', { quote: 'x' })).resolves.toBeUndefined()
  })

  it('a terminal tab carries the request from the moment it opens, focus flag included', async () => {
    const tabId = await canvasLifecycle.openTerminal('pty-1', 'zsh', { reveal: { quote: 'FAIL', keepFocus: true } })
    const terminal = () => canvasLifecycle.getTabs().find(tab => tab.id === tabId)
    expect(terminal()?.reveal).toMatchObject({ quote: 'FAIL', keepFocus: true })

    const first = terminal()!.reveal!.seq
    await canvasLifecycle.openFile('/repo/a.ts')
    const again = await canvasLifecycle.openTerminal('pty-1', 'zsh', { reveal: { quote: 'FAIL' } })
    expect(again).toBe(tabId)
    expect(terminal()?.reveal?.seq).not.toBe(first)
    expect(terminal()?.reveal?.keepFocus).toBeUndefined()
    expect(canvasLifecycle.getActiveTabId()).toBe(tabId)
  })
})
