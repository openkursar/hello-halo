/**
 * xterm adapter: selected terminal output becomes a reference (the output is
 * the only copy, so the quote is what the AI reads), and going back finds the
 * output in the buffer and lights its lines up. Pending references are not
 * marked in the terminal itself: its output streams and scrolls away, so a
 * mark would have to be searched for again and again.
 *
 * The returned handle is the terminal viewer's to release with the terminal.
 */

import type { IDisposable, Terminal } from '@xterm/xterm'
import type { TerminalReferenceSource } from '../../../../shared/types/content-reference'
import { afterPointerRelease, canOffer, offerSelection, SELECTION_SETTLE_MS, type SelectionRect } from '../selection'

const REVEAL_FLASH_MS = 1800
/** Share of the warning colour in the flash, over the terminal's own background. */
const FLASH_STRENGTH = 0.32

function selectionRect(term: Terminal): SelectionRect | null {
  const position = term.getSelectionPosition()
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!position || !screen || term.rows === 0 || term.cols === 0) return null
  const box = screen.getBoundingClientRect()
  const cellWidth = box.width / term.cols
  const cellHeight = box.height / term.rows
  const viewportTop = term.buffer.active.viewportY
  // Buffer positions are 1-based.
  const startRow = Math.max(0, position.start.y - 1 - viewportTop)
  const endRow = Math.min(term.rows - 1, position.end.y - 1 - viewportTop)
  const x = box.left + Math.min(term.cols, position.end.x - 1) * cellWidth
  const top = box.top + startRow * cellHeight
  return { left: x, right: x, top, bottom: box.top + (Math.max(startRow, endRow) + 1) * cellHeight }
}

/** Offers the terminal's selection as a reference; see the module comment. */
export function attachTerminalReferences(term: Terminal, source: () => TerminalReferenceSource): IDisposable {
  const owner = {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelRelease: (() => void) | null = null
  let disposed = false

  const offer = () => {
    if (disposed) return
    if (!term.hasSelection()) {
      offerSelection(owner, null)
      return
    }
    if (!canOffer()) return
    const quote = term.getSelection()
    const rect = selectionRect(term)
    if (!quote.trim() || !rect) {
      offerSelection(owner, null)
      return
    }
    offerSelection(owner, {
      draft: { source: source(), quote },
      rect,
      collapse: () => {
        if (!disposed) term.clearSelection()
      },
      refocus: () => {
        if (!disposed) term.focus()
      },
    })
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      cancelRelease?.()
      cancelRelease = afterPointerRelease(() => {
        cancelRelease = null
        offer()
      })
    }, SELECTION_SETTLE_MS)
  }

  const subscription = term.onSelectionChange(schedule)
  return {
    dispose: () => {
      disposed = true
      subscription.dispose()
      if (timer) clearTimeout(timer)
      cancelRelease?.()
      offerSelection(owner, null)
    },
  }
}

// ============================================
// Going back to output
// ============================================

function cssColorToRgb(value: string): [number, number, number] | null {
  const parts = value.trim().split(/[\s,/]+/)
  if (parts.length < 3) return null
  const h = Number(parts[0]) / 360
  const s = Number(parts[1].replace('%', '')) / 100
  const l = Number(parts[2].replace('%', '')) / 100
  if (![h, s, l].every(Number.isFinite)) return null
  const hueToRgb = (p: number, q: number, t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (u < 1 / 6) return p + (q - p) * 6 * u
    if (u < 1 / 2) return q
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6
    return p
  }
  if (s === 0) return [l, l, l].map(c => Math.round(c * 255)) as [number, number, number]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)].map(c => Math.round(c * 255)) as [number, number, number]
}

/** The flash colour as xterm wants it (`#RRGGBB` only): the theme's warning colour over the terminal's background. */
function flashColor(): string | undefined {
  const styles = getComputedStyle(document.documentElement)
  const warning = cssColorToRgb(styles.getPropertyValue('--halo-warning'))
  const background = cssColorToRgb(styles.getPropertyValue('--card'))
  if (!warning || !background) return undefined
  const mixed = warning.map((c, i) => Math.round(c * FLASH_STRENGTH + background[i] * (1 - FLASH_STRENGTH)))
  return `#${mixed.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

/** Buffer line (0-based) where `quote` starts, searching from the newest output back; -1 when absent. */
function findOutput(term: Terminal, quote: string): { line: number; lines: number } {
  const wanted = quote.split('\n').map(line => line.trimEnd()).filter(line => line.trim())
  if (wanted.length === 0) return { line: -1, lines: 0 }
  const buffer = term.buffer.active
  const first = wanted[0].trim()
  for (let y = buffer.length - 1; y >= 0; y--) {
    const text = buffer.getLine(y)?.translateToString(true) ?? ''
    if (!text.includes(first)) continue
    let matches = true
    for (let k = 1; k < Math.min(wanted.length, 3); k++) {
      const next = buffer.getLine(y + k)?.translateToString(true) ?? ''
      if (!next.includes(wanted[k].trim())) {
        matches = false
        break
      }
    }
    if (matches) return { line: y, lines: wanted.length }
  }
  return { line: -1, lines: 0 }
}

/** Where buffer lines `line`… show on screen, or null when the terminal is not laid out. */
function linesRect(term: Terminal, line: number, lines: number): SelectionRect | null {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || term.rows === 0) return null
  const box = screen.getBoundingClientRect()
  const cellHeight = box.height / term.rows
  const row = Math.max(0, Math.min(term.rows - 1, line - term.buffer.active.viewportY))
  const last = Math.max(row, Math.min(term.rows - 1, row + Math.max(1, lines) - 1))
  return { left: box.left, right: box.right, top: box.top + row * cellHeight, bottom: box.top + (last + 1) * cellHeight }
}

/** The top of the terminal's screen, where a comment opens when its output is gone. */
export function terminalTopRect(term: Terminal): SelectionRect | null {
  const box = term.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect()
  return box ? { left: box.left, right: box.right, top: box.top, bottom: box.top } : null
}

/** Scrolls to the output and lights its lines briefly; returns where it shows, or null when it is no longer in the buffer. */
export function revealInTerminal(term: Terminal, quote: string): SelectionRect | null {
  const { line, lines } = findOutput(term, quote)
  if (line < 0) return null
  term.scrollToLine(Math.max(0, line - Math.floor(term.rows / 3)))
  const color = flashColor()
  if (color) {
    const buffer = term.buffer.active
    const marker = term.registerMarker(line - (buffer.baseY + buffer.cursorY))
    const decoration = term.registerDecoration({ marker, width: term.cols, height: Math.max(1, lines), backgroundColor: color, layer: 'bottom' })
    setTimeout(() => {
      decoration?.dispose()
      marker.dispose()
    }, REVEAL_FLASH_MS)
  }
  return linesRect(term, line, lines)
}
