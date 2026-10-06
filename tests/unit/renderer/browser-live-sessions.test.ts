/**
 * The tray lists every live AI browser page of the space you are in, one row
 * per page, named after its owner — and never a page of another space.
 */

import { describe, expect, it } from 'vitest'
import { buildBrowserLiveSessions, pageOwnerAppId } from '../../../src/renderer/hooks/browser-live-sessions'
import type { AIBrowserPage } from '../../../src/renderer/stores/ai-browser.store'

const page = (viewId: string, conversationId: string, spaceId: string | null, extra: Partial<AIBrowserPage> = {}): AIBrowserPage =>
  ({ viewId, conversationId, spaceId, url: `https://${viewId}.test/x`, title: null, lastActivityAt: 1, ...extra })

const labels: Record<string, string> = { 'app-chat:dh1': 'Researcher', 'conv-1': 'Weekly report' }
const build = (
  pages: AIBrowserPage[],
  spaceId: string | undefined,
  operating: Record<string, boolean> = {},
  views: Record<string, { viewId: string }> = {},
) =>
  buildBrowserLiveSessions({
    pages: Object.fromEntries(pages.map(p => [p.viewId, p])),
    views: Object.fromEntries(Object.entries(views).map(([id, v]) => [id, { ...v, url: null, title: null, lastActivityAt: 0 }])),
    spaceId,
    operating,
    ownerLabel: id => labels[id] ?? '?',
    untitled: 'AI Browser',
  })

describe('browser rows in the live-session tray', () => {
  it('lists every page of every conversation in the space, one row each', () => {
    const rows = build([
      page('a', 'app-chat:dh1', 's1'),
      page('b', 'app-chat:dh1', 's1'),
      page('c', 'conv-1', 's1'),
    ], 's1')
    expect(rows.map(r => r.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('never shows a page of another space, or one with no space', () => {
    const rows = build([page('mine', 'conv-1', 's1'), page('theirs', 'conv-1', 's2'), page('orphan', 'conv-1', null)], 's1')
    expect(rows.map(r => r.id)).toEqual(['mine'])
  })

  it('shows nothing when no space is open', () => {
    expect(build([page('a', 'conv-1', 's1')], undefined)).toEqual([])
  })

  it('names each row after its owner and the page', () => {
    const [row] = build([page('a', 'app-chat:dh1', 's1', { title: 'Search results' })], 's1')
    expect(row.title).toBe('Researcher · Search results')
  })

  it('falls back to the host, then to a generic name', () => {
    expect(build([page('a', 'conv-1', 's1')], 's1')[0].title).toBe('Weekly report · a.test')
    expect(build([page('a', 'conv-1', 's1', { url: null })], 's1')[0].title).toBe('Weekly report · AI Browser')
  })

  it('pulses the rows of a conversation whose turn is driving the browser', () => {
    const rows = build([page('a', 'app-chat:dh1', 's1'), page('c', 'conv-1', 's1')], 's1', { 'app-chat:dh1': true })
    expect(Object.fromEntries(rows.map(r => [r.id, r.busy]))).toEqual({ a: true, c: false })
  })

  it('leaves out a page another conversation is on, so stopping it cannot pull it from under them', () => {
    const rows = build(
      [page('shared', 'conv-1', 's1'), page('mine', 'conv-1', 's1')],
      's1',
      {},
      { 'conv-1': { viewId: 'mine' }, 'conv-2': { viewId: 'shared' } },
    )
    expect(rows.map(r => r.id)).toEqual(['mine'])
  })

  it('carries the URL so the attached tab opens on the right page', () => {
    expect(build([page('a', 'conv-1', 's1')], 's1')[0].url).toBe('https://a.test/x')
  })
})

describe('who holds a page', () => {
  it('is the digital human for its chats and for a run started from the desktop, and no one for a space conversation', () => {
    expect(pageOwnerAppId('app-chat:dh1')).toBe('dh1')
    expect(pageOwnerAppId('app-run:dh1:run-7')).toBe('dh1')
    expect(pageOwnerAppId('conv-1')).toBeNull()
  })
})
