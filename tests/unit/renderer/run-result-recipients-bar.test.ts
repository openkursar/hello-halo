/**
 * Choosing many run-result recipients at once: the count, and select all /
 * clear acting on the contacts currently shown.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const translate = (text: string, vars?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars?.[key] ?? ''))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate }) }))

import { RunResultRecipientsBar, recipientsToChange } from '../../../src/renderer/components/apps/RunResultRecipientsBar'

type Contact = { id: string; on: boolean }
const contacts: Contact[] = [{ id: 'a', on: true }, { id: 'b', on: false }, { id: 'c', on: false }]
const isOn = (c: Contact) => c.on

describe('recipientsToChange', () => {
  it('select all touches only the shown contacts that are off', () => {
    expect(recipientsToChange(contacts, isOn, true).map(c => c.id)).toEqual(['b', 'c'])
  })

  it('clear touches only the shown contacts that are on', () => {
    expect(recipientsToChange(contacts, isOn, false).map(c => c.id)).toEqual(['a'])
  })
})

describe('RunResultRecipientsBar', () => {
  const render = (shown: Contact[]) =>
    renderToStaticMarkup(createElement(RunResultRecipientsBar<Contact>, { shown, isOn, onSet: () => {} }))

  it('shows how many of the shown contacts get run results', () => {
    const html = render(contacts)
    expect(html).toContain('1 of 3 get scheduled run results')
    expect(html).toContain('Select all')
    expect(html).toContain('Clear')
  })

  it('disables what would change nothing', () => {
    expect(render(contacts.map(c => ({ ...c, on: true })))).toMatch(/disabled=""[^>]*>Select all/)
    expect(render(contacts.map(c => ({ ...c, on: false })))).toMatch(/disabled=""[^>]*>Clear/)
  })

  it('stays out of the way for a single contact', () => {
    expect(render([contacts[0]])).toBe('')
  })
})
