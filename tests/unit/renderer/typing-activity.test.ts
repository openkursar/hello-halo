/**
 * "The user is typing" is read from where the keyboard focus is at the moment
 * the AI asks to show something: working in a page, a terminal or an editor, or
 * holding an unsent draft. An empty box or a focused button is not typing.
 */

import { describe, expect, it } from 'vitest'
import { isUserTyping } from '../../../src/renderer/services/typing-activity'

const body = {}
const doc = (activeElement: unknown) => ({ activeElement, body }) as never
const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, closest: () => null, isContentEditable: false, ...extra })

describe('isUserTyping', () => {
  it('is false when nothing has the focus', () => {
    expect(isUserTyping(doc(null))).toBe(false)
    expect(isUserTyping(doc(body))).toBe(false)
  })

  it('is true while working in a page, a terminal or an editor', () => {
    expect(isUserTyping(doc(el('WEBVIEW')))).toBe(true)
    expect(isUserTyping(doc(el('TEXTAREA', { closest: (selector: string) => (selector === '.xterm' ? {} : null), value: '' })))).toBe(true)
    expect(isUserTyping(doc(el('DIV', { isContentEditable: true })))).toBe(true)
  })

  it('is true for a draft in the composer or any text field, false once it is empty', () => {
    expect(isUserTyping(doc(el('TEXTAREA', { value: 'half a sentence' })))).toBe(true)
    expect(isUserTyping(doc(el('TEXTAREA', { value: '   ' })))).toBe(false)
    expect(isUserTyping(doc(el('TEXTAREA', { value: '' })))).toBe(false)
    expect(isUserTyping(doc(el('INPUT', { type: 'text', value: 'query' })))).toBe(true)
    expect(isUserTyping(doc(el('INPUT', { type: 'search', value: '' })))).toBe(false)
  })

  it('is false for controls that are not text entry', () => {
    expect(isUserTyping(doc(el('BUTTON')))).toBe(false)
    expect(isUserTyping(doc(el('INPUT', { type: 'checkbox', value: 'on' })))).toBe(false)
    expect(isUserTyping(doc(el('A')))).toBe(false)
  })
})
