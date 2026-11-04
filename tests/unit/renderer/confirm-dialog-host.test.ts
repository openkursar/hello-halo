/**
 * A confirmation raised from inside a modal <dialog> must be shown inside it:
 * the modal sits in the top layer and makes the rest of the page inert, so a
 * confirmation attached to the page body would be covered and unreachable.
 */

import { describe, expect, it } from 'vitest'
import { confirmationHost, confirmationIsShown } from '../../../src/renderer/components/ui/ConfirmDialog'

const element = (name: string) => ({ name }) as unknown as HTMLElement

function pageWith(openDialogs: HTMLElement[]) {
  const body = element('body')
  return { body, querySelectorAll: (selector: string) => (selector === 'dialog[open]' ? openDialogs : []) } as unknown as Pick<Document, 'body' | 'querySelectorAll'>
}

describe('where a confirmation is attached', () => {
  it('uses the page body when no dialog is open', () => {
    const page = pageWith([])
    expect(confirmationHost(page)).toBe(page.body)
  })

  it('uses the open modal dialog so the confirmation can be reached', () => {
    const dialog = element('dialog')
    expect(confirmationHost(pageWith([dialog]))).toBe(dialog)
  })

  it('uses the innermost of several open dialogs', () => {
    const outer = element('outer')
    const inner = element('inner')
    expect(confirmationHost(pageWith([outer, inner]))).toBe(inner)
  })
})

describe('whether a confirmation still answers keys', () => {
  it('answers while its element is in the document', () => {
    expect(confirmationIsShown({ isConnected: true })).toBe(true)
  })

  it('does not answer once its host closed and took the element out of the document', () => {
    expect(confirmationIsShown({ isConnected: false })).toBe(false)
  })

  it('does not answer before it has an element', () => {
    expect(confirmationIsShown(null)).toBe(false)
  })
})
