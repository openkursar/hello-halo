/**
 * Controls revealed on hover stay visible on narrow screens, where there is no
 * hover to reveal them (a phone, the remote page in a small window); and the
 * floating panels these screens open stay within the screen. Pinned on the
 * class names, the codebase's own convention (`max-sm:opacity-100`).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

const source = (path: string) => readFileSync(new URL(`../../../src/renderer/components/${path}`, import.meta.url), 'utf8')

/** Every class list that hides a control until its row is hovered. */
const hoverOnly = (text: string) =>
  [...text.matchAll(/(?:className=\{?[`"'])([^`"']*\bopacity-0\b[^`"']*\bgroup-hover[^`"']*)/g)].map(m => m[1])

describe('hover-revealed controls on narrow screens', () => {
  for (const path of ['apps/AppNotifyChannelsSection.tsx', 'tlon/WatchedFolderRow.tsx', 'tlon/RawFilesTab.tsx']) {
    it(`are always visible below the small breakpoint in ${path}`, () => {
      const lists = hoverOnly(source(path))
      expect(lists.length).toBeGreaterThan(0)
      for (const list of lists) expect(list, list).toContain('max-sm:opacity-100')
    })
  }

  it('covers the controls of a chat added from another bot too, which read the class from a condition', () => {
    expect(source('apps/AppNotifyChannelsSection.tsx')).toContain("'opacity-0 group-hover/contact:opacity-100 max-sm:opacity-100'")
  })
})

describe('floating panels on small screens', () => {
  it('lets the update dialog scroll instead of running off a short screen', () => {
    expect(source('store/StoreUpdateDialog.tsx')).toMatch(/className="relative w-full max-w-md max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto /)
  })

  it('keeps the search result bar within the screen, so a long query is cut short instead of pushing it off the edge', () => {
    expect(source('search/SearchHighlightBar.tsx')).toContain('<div className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)]">')
  })
})
