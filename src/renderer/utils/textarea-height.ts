/**
 * Sizes a textarea to its text by measuring an off-screen copy, so the
 * textarea itself never changes size to be measured.
 *
 * The common way — set `height: auto`, read `scrollHeight`, set it back —
 * collapses the box for one forced layout. A scroll container sized around it
 * (the transcript above the composer, a page around an editor) grows for that
 * moment, the browser clamps its scroll position, and the position stays
 * clamped once the box grows back: near the end, every keystroke moved the
 * view. The collapsed box also measured with a scrollbar taking width, so
 * wrapped text came out a line too tall.
 */

/** Everything that decides where the copy's text wraps and how tall its lines are. */
const SIZING_STYLES = [
  'box-sizing', 'width',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-variation-settings', 'font-kerning',
  'line-height', 'letter-spacing', 'word-spacing',
  'text-indent', 'text-transform', 'text-rendering', 'tab-size',
  'white-space', 'word-break', 'overflow-wrap', 'line-break', 'hyphens',
  'scrollbar-gutter', 'scrollbar-width',
] as const

let probe: HTMLTextAreaElement | null = null

function probeFor(doc: Document): HTMLTextAreaElement {
  if (probe?.isConnected && probe.ownerDocument === doc) return probe
  const host = doc.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  // Zero-sized and contained: nothing laid out inside reaches the page.
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict'
  const copy = doc.createElement('textarea')
  copy.tabIndex = -1
  copy.readOnly = true
  copy.spellcheck = false
  copy.style.cssText = 'display:block;margin:0;height:auto;min-height:0;max-height:none;overflow:hidden;border-style:solid;resize:none;appearance:none'
  // A closed shadow root keeps the copy out of the page's selectors and stylesheets.
  host.attachShadow({ mode: 'closed' }).appendChild(copy)
  doc.body.appendChild(host)
  probe = copy
  return copy
}

/**
 * Sets `el`'s height to fit its text (at least its `rows`), capped at
 * `maxHeight` when given. The element's own CSS min/max-height still apply.
 * Leaves an element that is not rendered as it is.
 */
export function fitTextareaHeight(el: HTMLTextAreaElement, maxHeight?: number): void {
  const doc = el.ownerDocument
  const view = doc.defaultView
  if (!view || !el.isConnected) return
  const style = view.getComputedStyle(el)
  // A used width is only resolved for a rendered element.
  if (!style.width.endsWith('px')) return

  // Text three times taller than the cap is capped whatever the copy says: the
  // copy is wider by at most a scrollbar, and one of its lines wraps into at
  // most three of the box's. Skipping it spares laying out a long draft per key.
  const cap = Math.min(maxHeight ?? Infinity, style.maxHeight.endsWith('px') ? parseFloat(style.maxHeight) : Infinity)
  if (el.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) >= 3 * cap) {
    const capped = `${cap}px`
    if (el.style.height !== capped) el.style.height = capped
    return
  }

  const copy = probeFor(doc)
  for (const name of SIZING_STYLES) copy.style.setProperty(name, style.getPropertyValue(name))
  copy.rows = el.rows
  copy.placeholder = el.placeholder
  copy.value = el.value

  const height = style.boxSizing === 'border-box'
    ? copy.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    : copy.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  const next = `${maxHeight === undefined ? height : Math.min(height, maxHeight)}px`
  if (el.style.height !== next) el.style.height = next
}
