/**
 * The code viewer remounts on every tab switch, so what the user was doing
 * must come from the tab, not from component state that no longer exists.
 */

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../../src/renderer/api', () => ({ api: { isRemoteMode: () => false } }))
vi.mock('../../../../src/renderer/hooks/useCanvasLifecycle', () => ({ useCanvasActions: () => ({ consumeReveal: vi.fn() }) }))
vi.mock('../../../../src/renderer/components/references', () => ({ referenceExtension: () => [], revealInEditor: vi.fn(), notifyRevealOutcome: vi.fn() }))

const { CodeViewer } = await import('../../../../src/renderer/components/canvas/viewers/CodeViewer')

const base = { id: 't1', type: 'code' as const, title: 'a.ts', path: '/w/a.ts', content: 'x', isLoading: false, view: {} }

describe('CodeViewer', () => {
  it('reopens a tab with unsaved edits in edit mode', () => {
    const html = renderToStaticMarkup(createElement(CodeViewer, { tab: { ...base, isDirty: true } }))
    expect(html).toContain('Editing')
  })

  it('opens a clean tab read-only', () => {
    const html = renderToStaticMarkup(createElement(CodeViewer, { tab: { ...base, isDirty: false } }))
    expect(html).not.toContain('Editing')
  })

  it('asks which side to keep when the file changed on disk under unsaved edits', () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, { tab: { ...base, isDirty: true, diskConflict: true } })
    )
    expect(html).toContain('This file changed on disk while you were editing it.')
    expect(html).toContain('Load disk version')
    expect(html).toContain('Keep my edits')
  })
})
