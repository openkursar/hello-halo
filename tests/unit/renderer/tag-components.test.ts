/**
 * The tag row, card chips and tag editor every extensions list shares.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const translate = (text: string, vars?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars?.[key] ?? ''))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate }) }))

import { TagFilterRow } from '../../../src/renderer/components/tags/TagFilterRow'
import { TagChips } from '../../../src/renderer/components/tags/TagChips'
import { TagEditor, toggleTag } from '../../../src/renderer/components/tags/TagEditor'

const ok = async () => true
const row = (props: Partial<Parameters<typeof TagFilterRow>[0]>) =>
  renderToStaticMarkup(createElement(TagFilterRow, { tags: [], value: '', onChange: () => {}, onRename: ok, onDelete: ok, ...props }))

describe('TagFilterRow', () => {
  it('is absent until a tag exists', () => {
    expect(row({})).toBe('')
  })

  it('offers All and each tag with its count, rename and delete only while one is chosen', () => {
    const tags = [{ name: '巡检', count: 5 }, { name: 'Ops', count: 1 }]
    const idle = row({ tags })
    expect(idle).toContain('All')
    expect(idle).toContain('巡检')
    expect(idle).toContain('>5<')
    expect(idle).not.toContain('Delete tag')
    const chosen = row({ tags, value: 'ops' })
    expect(chosen).toContain('Rename')
    expect(chosen).toContain('Delete tag')
    expect(chosen).toMatch(/aria-pressed="true"[^>]*>.*Ops/)
  })

  it('still lets a stale choice be cleared once its tag is gone', () => {
    expect(row({ value: 'gone' })).toContain('All')
  })
})

describe('TagChips', () => {
  it('shows two and folds the rest', () => {
    const html = renderToStaticMarkup(createElement(TagChips, { tags: ['a', 'b', 'c', 'd'] }))
    expect(html).toContain('>a<')
    expect(html).toContain('>b<')
    expect(html).not.toContain('>c<')
    expect(html).toContain('+2')
    expect(renderToStaticMarkup(createElement(TagChips, { tags: [] }))).toBe('')
  })
})

describe('TagEditor', () => {
  it('offers the list\'s tags as checkboxes, ticked where the item has them', () => {
    const html = renderToStaticMarkup(createElement(TagEditor, {
      value: ['Ops'], suggestions: [{ name: 'ops', count: 3 }, { name: '巡检', count: 1 }], onChange: () => {},
    }))
    expect(html).toContain('Add a tag')
    expect(html.match(/type="checkbox"/g)).toHaveLength(2)
    expect(html).toMatch(/checked=""[^>]*>[^<]*<span[^>]*>ops/)
  })

  it('toggles a tag whatever its case', () => {
    expect(toggleTag(['Ops'], 'ops')).toEqual([])
    expect(toggleTag(['Ops'], '巡检')).toEqual(['Ops', '巡检'])
  })
})
