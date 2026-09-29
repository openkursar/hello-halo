/**
 * A canvas tab attached to an AI page closes when that page is destroyed —
 * by view id, whether or not the page was the one its conversation was on —
 * while a tab the canvas owns is left to the canvas.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const hide = vi.fn(async () => ({ success: true }))
const destroy = vi.fn(async () => ({ success: true }))
vi.mock('../../../src/renderer/api', () => ({
  api: {
    onBrowserStateChange: () => () => {},
    onArtifactChanged: () => () => {},
    showBrowserView: vi.fn(async () => ({ success: true })),
    hideBrowserView: (...a: unknown[]) => hide(...(a as [])),
    destroyBrowserView: (...a: unknown[]) => destroy(...(a as [])),
    resizeBrowserView: vi.fn(async () => ({ success: true })),
  },
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../src/renderer/services/canvas-lifecycle')

beforeEach(async () => {
  await canvasLifecycle.closeAll()
  hide.mockClear()
  destroy.mockClear()
})

describe('closing tabs of a gone AI page', () => {
  it('closes every tab attached to the page, without destroying it again', async () => {
    await canvasLifecycle.attachAIBrowserView('page-a', 'https://a.test', 'A')
    await canvasLifecycle.attachAIBrowserView('page-b', 'https://b.test', 'B')

    await canvasLifecycle.closeTabsOfGoneView('page-a')

    expect(canvasLifecycle.getTabs().map(t => t.browserViewId)).toEqual(['page-b'])
    expect(destroy).not.toHaveBeenCalled()
  })

  it('leaves unrelated tabs alone for an unknown view', async () => {
    await canvasLifecycle.attachAIBrowserView('page-a', 'https://a.test', 'A')
    await canvasLifecycle.closeTabsOfGoneView('nope')
    expect(canvasLifecycle.getTabs()).toHaveLength(1)
  })
})
