/**
 * Adding a card from a selection: it goes only to the composer beside the
 * canvas, with the same feedback wherever the selection was made.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/renderer/i18n', () => ({
  default: { t: (key: string, options?: Record<string, unknown>) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? '')) },
}))

import { addReference } from '../../../../src/renderer/components/references/add-reference'
import { useComposerReferencesStore, type ReferenceDraft } from '../../../../src/renderer/stores/composer-references.store'
import { useNotificationStore } from '../../../../src/renderer/stores/notification.store'
import { REFERENCE_LIMITS } from '../../../../src/shared/types/content-reference'

const draft: ReferenceDraft = { source: { kind: 'terminal', title: 'zsh', sessionId: 't1' }, quote: 'FAIL tests/a.test.ts' }
const store = () => useComposerReferencesStore.getState()
const toasts = () => useNotificationStore.getState().toasts

beforeEach(() => {
  useComposerReferencesStore.setState({ drafts: new Map(), target: null, signal: null })
  useNotificationStore.getState().clear()
})

describe('addReference', () => {
  it('does nothing where no composer sits beside the content', () => {
    expect(addReference(draft)).toBe(false)
    expect(store().drafts.size).toBe(0)
  })

  it('with the composer on screen, adds the card and asks it to pulse, taking the caret only when asked', () => {
    store().setTarget({ key: 'c1', title: 'Fix the router', visible: true, reveal: vi.fn() })
    expect(addReference(draft, { focusComposer: true })).toBe(true)
    expect(store().drafts.get('c1')).toHaveLength(1)
    expect(store().signal).toMatchObject({ key: 'c1', focus: 'text' })
    addReference({ ...draft, note: 'why?' })
    expect(store().signal).toMatchObject({ key: 'c1', focus: 'none' })
    expect(toasts()).toHaveLength(0)
  })

  it('with the composer out of sight, says where the card went and offers the way back', () => {
    const reveal = vi.fn()
    store().setTarget({ key: 'c1', title: 'Fix the router', visible: false, reveal })
    addReference(draft)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].title).toBe('Added to “Fix the router”')
    expect(toasts()[0].action?.label).toBe('Return to conversation')
    toasts()[0].action!.onClick()
    expect(reveal).toHaveBeenCalled()
    expect(store().signal).toMatchObject({ key: 'c1', focus: 'text' })
  })

  it('names a comment, and a conversation without a title, in the notice', () => {
    store().setTarget({ key: 'c1', title: '', visible: false, reveal: vi.fn() })
    addReference({ ...draft, note: 'please fix' })
    expect(toasts()[0].title).toBe('Comment added to the new conversation')
  })

  it('refuses past the per-message limit and says so', () => {
    store().setTarget({ key: 'c1', title: 'T', visible: true, reveal: vi.fn() })
    for (let i = 0; i < REFERENCE_LIMITS.maxPerMessage; i++) expect(addReference(draft)).toBe(true)
    expect(addReference(draft)).toBe(false)
    expect(store().drafts.get('c1')).toHaveLength(REFERENCE_LIMITS.maxPerMessage)
    expect(toasts().at(-1)?.title).toBe(`You can add up to ${REFERENCE_LIMITS.maxPerMessage} references to a message`)
  })
})
