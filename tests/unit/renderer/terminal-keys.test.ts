/**
 * Ctrl+C in the terminal: a copy only on Windows and Linux with text selected;
 * an interrupt otherwise, and always on macOS, where ⌘C copies natively.
 */

import { describe, expect, it } from 'vitest'
import { copiesSelection } from '../../../src/renderer/lib/terminal-keys'

const press = (modifiers: Partial<KeyboardEvent> = {}, key = 'c') => ({ key, ctrlKey: false, metaKey: false, ...modifiers })

describe('Ctrl+C in the terminal', () => {
  it('copies the selection on Windows and Linux', () => {
    expect(copiesSelection(press({ ctrlKey: true }), false, 'npm test')).toBe(true)
  })

  it('interrupts when nothing, or only blank cells, are selected', () => {
    expect(copiesSelection(press({ ctrlKey: true }), false, '')).toBe(false)
  })

  it('always interrupts on macOS, and leaves ⌘C to the native copy', () => {
    expect(copiesSelection(press({ ctrlKey: true }), true, 'npm test')).toBe(false)
    expect(copiesSelection(press({ metaKey: true }), true, 'npm test')).toBe(false)
  })

  it('leaves other keys and a bare C to the shell', () => {
    expect(copiesSelection(press({ ctrlKey: true }, 'v'), false, 'npm test')).toBe(false)
    expect(copiesSelection(press(), false, 'npm test')).toBe(false)
  })
})
