/**
 * Going back to a place from a reference. Handing it on to the file itself,
 * for a viewer that cannot show it: the file opens there (keeping the
 * composer's caret when asked), a file of the space that is gone is reported
 * instead of opened, and a request that names no place opens the file
 * plainly. A pending comment gone back to asks for its card there to take the
 * focus, to be edited — and when the place cannot be shown (a closed
 * terminal, a deleted message or file, a file that cannot be read), the usual
 * notice comes first, then the comment opens beside the composer's comments
 * chip, still to be read, edited and deleted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openFile: vi.fn(async () => 'tab-1'),
  openChanges: vi.fn(async () => 'tab-2'),
  tabs: new Map<string, { id: string; isLoading: boolean; error?: string }>(),
  resolveArtifactPaths: vi.fn(),
  space: { current: null as null | { id: string; path: string; workingDir?: string } },
  chat: { active: 'conv-1', existing: new Set(['conv-1']), selectConversation: vi.fn() },
}))

vi.mock('../../../../src/renderer/i18n', () => ({
  default: { t: (key: string, options?: Record<string, unknown>) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? '')) },
}))
vi.mock('../../../../src/renderer/api', () => ({ api: { resolveArtifactPaths: mocks.resolveArtifactPaths } }))
vi.mock('../../../../src/renderer/api/transport', () => ({ isElectron: () => true }))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: { openFile: mocks.openFile, openChanges: mocks.openChanges, getTab: (id: string) => mocks.tabs.get(id), getTabs: () => [] },
}))
vi.mock('../../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({ currentSpace: mocks.space.current }) } }))
vi.mock('../../../../src/renderer/stores/chat.store', () => ({
  conversationKind: () => 'space',
  digitalHumanAppId: () => null,
  selectActiveConversationId: () => mocks.chat.active,
  useChatStore: { getState: () => ({ currentSpaceId: 's1', selectConversation: mocks.chat.selectConversation }) },
}))
vi.mock('../../../../src/renderer/stores/terminal.store', () => ({ useTerminalStore: { getState: () => ({ sessions: new Map() }) } }))
vi.mock('../../../../src/renderer/components/references/adapters/dom-text', () => ({ revealInElement: vi.fn() }))

const { revealFileAt, revealMessage, revealReference } = await import('../../../../src/renderer/components/references/reveal')
const { useNotificationStore } = await import('../../../../src/renderer/stores/notification.store')
const { useComposerReferencesStore } = await import('../../../../src/renderer/stores/composer-references.store')
const { useSelectionStore } = await import('../../../../src/renderer/components/references/selection')

const toasts = () => useNotificationStore.getState().toasts
const exists = (path: string, absolutePath: string | null) =>
  mocks.resolveArtifactPaths.mockResolvedValue({ success: true, data: [{ path, absolutePath, isDirectory: false }] })

/** The composer's comments chip, where a comment that cannot be shown at its place opens. */
const CHIP = { left: 40, top: 700, right: 140, bottom: 728 }

beforeEach(() => {
  mocks.openFile.mockClear()
  mocks.openChanges.mockClear()
  mocks.tabs.clear()
  mocks.resolveArtifactPaths.mockReset()
  mocks.space.current = { id: 's1', path: '/repo' }
  mocks.chat.active = 'conv-1'
  mocks.chat.existing = new Set(['conv-1'])
  mocks.chat.selectConversation.mockReset().mockImplementation(async (id: string) => {
    if (mocks.chat.existing.has(id)) mocks.chat.active = id
  })
  useNotificationStore.getState().clear()
  useComposerReferencesStore.setState({ drafts: new Map(), target: { key: 'conv-1', title: 'T', visible: true, reveal: vi.fn() }, signal: null })
  useSelectionStore.setState({ offered: null, commenting: null, viewing: null })
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16))
  vi.stubGlobal('window', { innerHeight: 800, dispatchEvent: vi.fn() })
  vi.stubGlobal('document', {
    querySelector: (selector: string) => (selector === '[data-composer-comments="conv-1"]'
      ? { getBoundingClientRect: () => ({ ...CHIP, width: 100, height: 28 }) }
      : null),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('revealFileAt', () => {
  it('opens the file at the place, passing the composer focus flag through', async () => {
    exists('/repo/src/a.ts', '/repo/src/a.ts')
    await revealFileAt('/repo/src/a.ts', { range: { startLine: 3, endLine: 4 }, quote: 'const a', keepFocus: true })
    expect(mocks.openFile).toHaveBeenCalledWith('/repo/src/a.ts', {
      reveal: { range: { startLine: 3, endLine: 4 }, quote: 'const a', keepFocus: true },
    })
    expect(toasts()).toHaveLength(0)
  })

  it('says a file of the space no longer exists instead of opening it', async () => {
    exists('/repo/src/gone.ts', null)
    await revealFileAt('/repo/src/gone.ts', { quote: 'x' })
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(toasts()[0].title).toBe('gone.ts no longer exists')
  })

  it('opens a file outside the space without asking, since nobody can tell', async () => {
    await revealFileAt('/elsewhere/b.ts', { quote: 'y' })
    expect(mocks.resolveArtifactPaths).not.toHaveBeenCalled()
    expect(mocks.openFile).toHaveBeenCalledWith('/elsewhere/b.ts', { reveal: { quote: 'y' } })
  })

  it('opens the file plainly when the request names no place', async () => {
    await revealFileAt('/elsewhere/b.ts', { keepFocus: true })
    expect(mocks.openFile).toHaveBeenCalledWith('/elsewhere/b.ts', undefined)
  })
})

describe('revealReference', () => {
  const comment = {
    id: 'ref-7',
    source: { kind: 'diff' as const, path: '/repo/src/a.ts', side: 'after' as const, compareLabel: 'Uncommitted changes', repo: { root: '/repo' } },
    range: { startLine: 11, endLine: 12 },
    quote: 'const a = 1',
    note: 'Why?',
  }

  it('asks the card of a pending comment gone back to for editing to take the focus', async () => {
    await revealReference(comment, { focusComment: true })
    expect(mocks.openChanges).toHaveBeenCalledWith(
      { kind: 'git', spaceId: 's1', repoRoot: '/repo' },
      { reveal: expect.objectContaining({ path: '/repo/src/a.ts', side: 'after', commentId: 'ref-7' }) },
    )
  })

  it('a selection is only shown, keeping the caret where the user types', async () => {
    const { note: _note, ...selection } = comment
    await revealReference(selection, { focusComment: true, keepFocus: true })
    const [, options] = mocks.openChanges.mock.calls[0] as unknown as [unknown, { reveal: Record<string, unknown> }]
    expect(options.reveal.commentId).toBeUndefined()
    expect(options.reveal.keepFocus).toBe(true)
  })

  it('a file comment carries the request to the file it opens', async () => {
    exists('/repo/src/b.ts', '/repo/src/b.ts')
    mocks.tabs.set('tab-1', { id: 'tab-1', isLoading: false })
    await revealReference(
      { id: 'ref-8', source: { kind: 'file', path: '/repo/src/b.ts', precision: 'lines' }, range: { startLine: 3, endLine: 3 }, quote: 'x', note: 'Check' },
      { focusComment: true },
    )
    expect(mocks.openFile).toHaveBeenCalledWith('/repo/src/b.ts', { reveal: expect.objectContaining({ commentId: 'ref-8' }) })
    expect(useSelectionStore.getState().viewing).toBeNull()
  })
})

describe('a comment whose place cannot be shown', () => {
  const comment = (id: string, source: Parameters<typeof revealReference>[0]['source']) => ({ id, source, quote: 'FAIL a.test.ts', note: 'Why does this fail?' })
  /** Puts the comment in the composer beside the canvas, as the chips show it. */
  const pending = <T extends { id: string }>(ref: T): T => {
    useComposerReferencesStore.setState({ drafts: new Map([['conv-1', [ref as never]]]) })
    return ref
  }
  /** What happens, in order: notices by their title, the floating card by where it opens. */
  function record() {
    const events: string[] = []
    const stops = [
      useNotificationStore.subscribe((state, previous) => {
        if (state.toasts.length > previous.toasts.length) events.push(`notice: ${state.toasts[state.toasts.length - 1].title}`)
      }),
      useSelectionStore.subscribe((state, previous) => {
        if (state.viewing && state.viewing !== previous.viewing) events.push(`card: ${state.viewing.id}`)
      }),
    ]
    return { events, stop: () => stops.forEach(stop => stop()) }
  }

  it('a closed terminal: the notice, then the comment beside the composer chip, focused', async () => {
    const ref = pending(comment('ref-9', { kind: 'terminal', title: 'zsh', sessionId: 'gone' }))
    const log = record()
    await revealReference(ref, { focusComment: true })
    log.stop()
    expect(log.events).toEqual(['notice: That terminal is closed', 'card: ref-9'])
    expect(useSelectionStore.getState().viewing).toEqual({ id: 'ref-9', rect: CHIP, focus: true })
  })

  it('a deleted file of the space: the notice, then the comment beside the chip', async () => {
    exists('/repo/src/gone.ts', null)
    const ref = pending({ ...comment('ref-10', { kind: 'file', path: '/repo/src/gone.ts', precision: 'lines' }), range: { startLine: 2, endLine: 2 } })
    const log = record()
    await revealReference(ref, { focusComment: true })
    log.stop()
    expect(log.events).toEqual(['notice: gone.ts no longer exists', 'card: ref-10'])
    expect(useSelectionStore.getState().viewing?.rect).toEqual(CHIP)
  })

  it('a file that opens but cannot be read: the comment beside the chip', async () => {
    mocks.tabs.set('tab-1', { id: 'tab-1', isLoading: false, error: 'EACCES' })
    const ref = pending(comment('ref-11', { kind: 'file', path: '/elsewhere/locked.ts', precision: 'lines' }))
    await revealReference(ref, { focusComment: true })
    expect(useSelectionStore.getState().viewing).toEqual({ id: 'ref-11', rect: CHIP, focus: true })
  })

  it('a deleted message in another conversation: the notice, back to the conversation it was written in, the comment beside the chip', async () => {
    mocks.chat.existing.add('conv-2')
    vi.stubGlobal('document', {
      querySelector: (selector: string) => (selector === '[data-composer-comments="conv-1"]' && mocks.chat.active === 'conv-1'
        ? { getBoundingClientRect: () => ({ ...CHIP, width: 100, height: 28 }) }
        : null),
    })
    vi.useFakeTimers()
    try {
      const ref = pending(comment('ref-12', { kind: 'message', conversationId: 'conv-2', messageId: 'm-gone', conversationTitle: 'Review' }))
      const log = record()
      const done = revealReference(ref, { focusComment: true })
      await vi.advanceTimersByTimeAsync(5000)
      await done
      log.stop()
      expect(log.events).toEqual(['notice: That message is no longer available', 'card: ref-12'])
      expect(mocks.chat.active).toBe('conv-1')
      expect(useSelectionStore.getState().viewing?.rect).toEqual(CHIP)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a deleted conversation: the notice, then the comment beside the chip, staying where the user is', async () => {
    const ref = pending(comment('ref-13', { kind: 'message', conversationId: 'conv-deleted', messageId: 'm1', conversationTitle: 'Old' }))
    expect(await revealMessage('conv-deleted', 'm1', ref.quote, { commentId: ref.id })).toBe(false)
    expect(toasts()[0].title).toBe('That message is no longer available')
    expect(mocks.chat.active).toBe('conv-1')
    expect(useSelectionStore.getState().viewing).toEqual({ id: 'ref-13', rect: CHIP, focus: true })
  })

  it('a selection (no comment) only gets the notice', async () => {
    const { note: _note, ...selection } = comment('ref-14', { kind: 'terminal', title: 'zsh', sessionId: 'gone' })
    pending(selection)
    await revealReference(selection, { focusComment: true, keepFocus: true })
    expect(toasts()[0].title).toBe('That terminal is closed')
    expect(useSelectionStore.getState().viewing).toBeNull()
  })
})
