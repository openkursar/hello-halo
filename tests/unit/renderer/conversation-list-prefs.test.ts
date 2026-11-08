/**
 * The conversation list remembers on this device whether the user left it
 * folded to its icon strip, separately beside open files and without them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY = 'halo-conversation-list-prefs'

function memoryStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  }
}

/** A fresh copy of the store reading `storage`, as after a restart. */
async function loadPrefs(storage: ReturnType<typeof memoryStorage>) {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage)
  return import('../../../src/renderer/stores/conversation-list-prefs.store')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the list fold choice', () => {
  it('starts folded beside open files and open without them', async () => {
    const { useConversationListPrefs, isListFolded } = await loadPrefs(memoryStorage())
    const { listFolded } = useConversationListPrefs.getState()
    expect(isListFolded(listFolded, 'with-canvas')).toBe(true)
    expect(isListFolded(listFolded, 'without-canvas')).toBe(false)
  })

  it('keeps each layout\'s choice apart', async () => {
    const { useConversationListPrefs, isListFolded } = await loadPrefs(memoryStorage())
    useConversationListPrefs.getState().setListFolded('with-canvas', false)
    expect(isListFolded(useConversationListPrefs.getState().listFolded, 'with-canvas')).toBe(false)
    expect(isListFolded(useConversationListPrefs.getState().listFolded, 'without-canvas')).toBe(false)

    useConversationListPrefs.getState().setListFolded('without-canvas', true)
    expect(useConversationListPrefs.getState().listFolded).toEqual({ 'with-canvas': false, 'without-canvas': true })
  })

  it('leaves the state as it was when the choice does not change', async () => {
    const { useConversationListPrefs } = await loadPrefs(memoryStorage())
    useConversationListPrefs.getState().setListFolded('with-canvas', false)
    const before = useConversationListPrefs.getState()
    useConversationListPrefs.getState().setListFolded('with-canvas', false)
    expect(useConversationListPrefs.getState()).toBe(before)
  })

  it('survives a restart', async () => {
    const storage = memoryStorage()
    const before = await loadPrefs(storage)
    before.useConversationListPrefs.getState().setListFolded('with-canvas', false)
    before.useConversationListPrefs.getState().setListFolded('without-canvas', true)

    const after = await loadPrefs(storage)
    expect(after.useConversationListPrefs.getState().listFolded).toEqual({ 'with-canvas': false, 'without-canvas': true })
  })

  it('reads choices saved before the list could be folded, keeping them and the defaults', async () => {
    const saved = { state: { sectionOpen: { s1: { pinned: false } }, appGroupOpen: { s1: { amy: true } }, paneHeights: { pinned: 120 } }, version: 0 }
    const { useConversationListPrefs, isListFolded } = await loadPrefs(memoryStorage({ [KEY]: JSON.stringify(saved) }))
    const state = useConversationListPrefs.getState()
    expect(state.sectionOpen).toEqual(saved.state.sectionOpen)
    expect(state.appGroupOpen).toEqual(saved.state.appGroupOpen)
    expect(state.paneHeights).toEqual(saved.state.paneHeights)
    expect(isListFolded(state.listFolded, 'with-canvas')).toBe(true)
    expect(isListFolded(state.listFolded, 'without-canvas')).toBe(false)
  })
})
