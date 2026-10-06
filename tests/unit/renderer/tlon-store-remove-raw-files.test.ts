/**
 * Removing several knowledge base files reports exactly which ones were not
 * removed, and refreshes the file list and the counts once for the batch.
 *
 * Main answers a file it could not delete with success and data false; the
 * batch used to count that as removed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { tlon } = vi.hoisted(() => ({
  tlon: {
    removeRaw: vi.fn(),
    listRaw: vi.fn(async () => ({ success: true, data: [] })),
    get: vi.fn(async () => ({ success: true, data: { id: 'kb1' } })),
  },
}))

vi.mock('../../../src/renderer/api', () => ({ api: { tlon } }))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (text: string) => text } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: { getState: () => ({}) } }))

import { useTlonStore } from '../../../src/renderer/stores/tlon.store'

describe('removing several knowledge base files', () => {
  beforeEach(() => {
    tlon.removeRaw.mockReset()
    tlon.listRaw.mockClear()
    tlon.get.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('names every file that was not removed, whichever way it failed', async () => {
    tlon.removeRaw.mockImplementation(async (_kbId: string, path: string) => {
      if (path === 'kept.md') return { success: true, data: false }
      if (path === 'refused.md') return { success: false, error: 'busy' }
      if (path === 'lost.md') throw new Error('connection closed')
      return { success: true, data: true }
    })

    const result = await useTlonStore.getState().removeRawFiles('kb1', ['gone.md', 'kept.md', 'refused.md', 'lost.md'])

    expect(result).toEqual({ failed: ['kept.md', 'refused.md', 'lost.md'] })
    // One refresh for the whole batch, so the groups and the counts update together.
    expect(tlon.listRaw).toHaveBeenCalledTimes(1)
    expect(tlon.get).toHaveBeenCalledTimes(1)
  })

  it('refreshes nothing when no file was removed', async () => {
    tlon.removeRaw.mockResolvedValue({ success: true, data: false })

    const result = await useTlonStore.getState().removeRawFiles('kb1', ['a.md', 'b.md'])

    expect(result).toEqual({ failed: ['a.md', 'b.md'] })
    expect(tlon.listRaw).not.toHaveBeenCalled()
    expect(tlon.get).not.toHaveBeenCalled()
  })
})
