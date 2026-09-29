/**
 * The confirmation dialog guards grants like "any command": Enter must never
 * confirm while a control (the default-focused Cancel above all) has focus.
 */

import { describe, expect, it } from 'vitest'
import { enterConfirms } from '../../../src/renderer/components/ui/ConfirmDialog'

const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable })

describe('Enter in the confirmation dialog', () => {
  it('on the focused Cancel button it is left to the button — it cancels', () => {
    expect(enterConfirms(el('BUTTON'))).toBe(false)
  })

  it('leaves text entry and links alone', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'A']) expect(enterConfirms(el(tag))).toBe(false)
    expect(enterConfirms(el('DIV', true))).toBe(false)
  })

  it('confirms when nothing in particular has focus', () => {
    expect(enterConfirms(el('BODY'))).toBe(true)
    expect(enterConfirms(el('DIV'))).toBe(true)
    expect(enterConfirms(null)).toBe(true)
  })
})
