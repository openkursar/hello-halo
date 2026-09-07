import type { Page } from '@playwright/test'

/**
 * Counts the DOM that is still attached to the document, by tag and by the
 * container path it hangs under.
 *
 * Its purpose is one decision, made before any deeper tooling is worth
 * running: CDP's `Nodes` counter includes nodes that are detached but still
 * referenced, so comparing it against this census splits the growth into
 * "a container keeps accumulating children" — visible here, and findable by
 * reading the path that grew — and "something in JS holds detached subtrees",
 * which this cannot see and a heap snapshot can.
 */

export interface DomCensus {
  elements: number
  textNodes: number
  comments: number
  /** Sum of the three, comparable to CDP's `Nodes` for the attached share. */
  attachedTotal: number
  byTag: Record<string, number>
  /** Keyed by the element's ancestor chain, so an accumulating container shows up as one growing key. */
  byPath: Record<string, number>
}

const CENSUS_SOURCE = `
(() => {
  function label(el) {
    if (!el || el.nodeType !== 1) return '?'
    let out = el.tagName.toLowerCase()
    if (el.id) out += '#' + el.id
    else if (typeof el.className === 'string' && el.className.trim()) {
      out += '.' + el.className.trim().split(/\\s+/)[0]
    }
    return out
  }

  // Depth 5 keeps sibling-heavy lists collapsed onto one key while still
  // naming the container they hang under.
  function pathOf(el) {
    const parts = []
    let node = el
    for (let depth = 0; depth < 5 && node && node.nodeType === 1; depth++) {
      parts.unshift(label(node))
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  const byTag = {}
  const byPath = {}
  const all = document.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    const tag = el.tagName.toLowerCase()
    byTag[tag] = (byTag[tag] || 0) + 1
    const path = pathOf(el)
    byPath[path] = (byPath[path] || 0) + 1
  }

  let textNodes = 0
  let comments = 0
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT)
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === 8) comments++
    else textNodes++
  }

  return {
    elements: all.length,
    textNodes,
    comments,
    attachedTotal: all.length + textNodes + comments,
    byTag,
    byPath
  }
})()
`

export async function takeDomCensus(page: Page): Promise<DomCensus> {
  return (await page.evaluate(CENSUS_SOURCE)) as DomCensus
}

export interface CensusDelta {
  key: string
  before: number
  after: number
  delta: number
}

/** Entries that moved, largest growth first. */
export function diffCensusMap(before: Record<string, number>, after: Record<string, number>): CensusDelta[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: CensusDelta[] = []
  for (const key of keys) {
    const b = before[key] || 0
    const a = after[key] || 0
    if (a !== b) out.push({ key, before: b, after: a, delta: a - b })
  }
  return out.sort((x, y) => y.delta - x.delta)
}
