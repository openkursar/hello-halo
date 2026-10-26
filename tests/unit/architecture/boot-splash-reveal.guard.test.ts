/**
 * The window shows the boot splash in its first frame only because the splash
 * holds a laid-out <canvas>: Electron emits ready-to-show once Blink counts the
 * page as having content. This starts deferred services after the first frame.
 * At a screen scale or display size other than 100%, nothing else in the splash
 * counts (see index.html). A missing or hidden canvas delays that cue until the
 * app's script runs.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const indexHtml = readFileSync(resolve(__dirname, '../../../src/renderer/index.html'), 'utf-8')

const VOID_ELEMENTS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr'])

interface Element {
  tag: string
  attrs: string
}

/** The open elements around the first <canvas> inside #boot-splash, outermost first, then the canvas. */
function canvasChain(html: string): Element[] | null {
  const body = html.replace(/<!--[\s\S]*?-->/g, '')
  const start = body.indexOf('<div id="boot-splash"')
  if (start < 0) throw new Error('index.html has no #boot-splash')
  const stack: Element[] = []
  for (const match of body.slice(start).matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*)>/gi)) {
    const [, closing, name, attrs] = match
    const tag = name.toLowerCase()
    if (closing) {
      stack.pop()
      if (stack.length === 0) return null
      continue
    }
    if (tag === 'canvas') return [...stack, { tag, attrs }]
    if (!VOID_ELEMENTS.has(tag) && !attrs.trim().endsWith('/')) stack.push({ tag, attrs })
  }
  return null
}

const hasHiddenAttribute = (element: Element) => /(^|\s)hidden(\s|=|\/|$)/.test(element.attrs.replace(/"[^"]*"/g, '""'))

const attr = (element: Element, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(element.attrs)?.[1]

/** Whether the last compound of a CSS selector (pseudo-classes dropped) matches the element. */
function selectorMatches(selector: string, element: Element): boolean {
  const compound = selector.trim().split(/[\s>+~]+/).pop()!.replace(/:[\w-]+(\([^)]*\))?/g, '')
  const tag = /^[a-z][\w-]*/i.exec(compound)?.[0]
  if (tag && tag !== '*' && tag.toLowerCase() !== element.tag) return false
  const id = attr(element, 'id')
  const classes = new Set((attr(element, 'class') ?? '').split(/\s+/).filter(Boolean))
  for (const [, kind, name] of compound.matchAll(/([#.])([\w-]+)/g)) {
    if (kind === '#' ? id !== name : !classes.has(name)) return false
  }
  return true
}

/**
 * Selectors of the page's own stylesheet rules that hide their element, those
 * inside `@media` and other at-rules included. An at-rule's prelude is dropped
 * first: read as a selector, it would stand for the at-rule's first rule.
 */
function hidingSelectors(html: string): string[] {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .flatMap(([, css]) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@[^{};]*\{/g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)])
    .filter(([, , body]) => /display\s*:\s*none/.test(body))
    .flatMap(([, selectors]) => selectors.split(','))
}

describe('boot splash reveal guard', () => {
  it('the boot splash holds a canvas', () => {
    expect(canvasChain(indexHtml)).not.toBeNull()
  })

  it('nothing hides the canvas or an element around it', () => {
    for (const element of canvasChain(indexHtml)!) {
      const label = `<${element.tag}${element.attrs}>`
      expect(hasHiddenAttribute(element), `${label} has the hidden attribute`).toBe(false)
      expect(/display\s*:\s*none/.test(attr(element, 'style') ?? ''), `${label} has display:none inline`).toBe(false)
      for (const selector of hidingSelectors(indexHtml)) {
        expect(selectorMatches(selector, element), `"${selector.trim()}" hides ${label}`).toBe(false)
      }
    }
  })

  it('catches a canvas that is missing or hidden', () => {
    const withoutCanvas = indexHtml.replace(/<canvas[^>]*><\/canvas>/, '')
    expect(canvasChain(withoutCanvas)).toBeNull()

    const hiddenParent = indexHtml.replace(/(<canvas[^>]*><\/canvas>)/, '<div hidden>$1</div>')
    expect(canvasChain(hiddenParent)!.some(hasHiddenAttribute)).toBe(true)

    expect(selectorMatches('#boot-splash canvas', { tag: 'canvas', attrs: '' })).toBe(true)
    expect(selectorMatches('html.light .boot-splash-arc-dark', { tag: 'canvas', attrs: '' })).toBe(false)
  })

  it('reads the rules inside @media blocks as rules', () => {
    const withCss = (css: string) => indexHtml.replace('</style>', `${css}\n    </style>`)
    const hidesTheCanvas = (html: string) =>
      canvasChain(html)!.some((element) => hidingSelectors(html).some((selector) => selectorMatches(selector, element)))

    expect(hidesTheCanvas(withCss('@media (max-width: 640px) { .boot-splash-tagline { display: none; } }'))).toBe(false)
    expect(hidesTheCanvas(withCss('@media (prefers-reduced-motion: reduce) { #boot-splash canvas { display: none; } }'))).toBe(true)
  })
})
