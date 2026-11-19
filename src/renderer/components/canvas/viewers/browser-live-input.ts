/**
 * Turns what a person does over a live frame into page input. Positions and
 * deltas leave as fractions of the frame as displayed, so nothing here needs
 * the page's real size. Kept free of React and the DOM so gestures can be
 * tested as plain event sequences.
 */

import type { BrowserLiveInput, BrowserLiveModifier } from '../../../../shared/types/browser-live'

export interface FrameRect {
  left: number
  top: number
  width: number
  height: number
}

interface ModifierState {
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

export interface PointerLike extends ModifierState {
  pointerType: string
  button: number
  clientX: number
  clientY: number
}

export interface WheelLike {
  clientX: number
  clientY: number
  deltaX: number
  deltaY: number
  deltaMode: number
}

export interface KeyLike extends ModifierState {
  key: string
  isComposing?: boolean
}

/** Moves and wheel ticks arrive far faster than frames; this is the rate they leave at. */
const FLUSH_MS = 50
const MULTI_CLICK_MS = 400
const MULTI_CLICK_DISTANCE = 6
/** A finger that travels this far is scrolling, not tapping. */
const TAP_SLOP = 8
const LINE_HEIGHT = 16
export const MAX_TEXT_LENGTH = 10_000

const BUTTONS = ['left', 'middle', 'right'] as const
/** Modifiers travel with the key they modify, never on their own. */
const LONE_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS'])
/** What the viewer's own input method produces instead of a key name. */
const NOT_KEYS = new Set(['Process', 'Unidentified', 'Dead'])

function modifiersOf(event: ModifierState): BrowserLiveModifier[] {
  const modifiers: BrowserLiveModifier[] = []
  if (event.shiftKey) modifiers.push('shift')
  if (event.ctrlKey) modifiers.push('control')
  if (event.altKey) modifiers.push('alt')
  if (event.metaKey) modifiers.push('meta')
  return modifiers
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function at(rect: FrameRect, clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: clamp(rect.width > 0 ? (clientX - rect.left) / rect.width : 0),
    y: clamp(rect.height > 0 ? (clientY - rect.top) / rect.height : 0),
  }
}

export class BrowserLiveInputController {
  private lastClick: { at: number; clientX: number; clientY: number; count: number } | null = null
  private pendingMove: BrowserLiveInput | null = null
  private moveTimer: ReturnType<typeof setTimeout> | null = null
  private lastMoveAt = -Infinity
  private scroll: { x: number; y: number; deltaX: number; deltaY: number } | null = null
  private scrollTimer: ReturnType<typeof setTimeout> | null = null
  private pendingJump: BrowserLiveInput | null = null
  private jumpTimer: ReturnType<typeof setTimeout> | null = null
  private lastJumpAt = -Infinity
  private touch: { startX: number; startY: number; lastX: number; lastY: number; scrolling: boolean } | null = null
  private readonly heldButtons = new Map<number, { x: number; y: number }>()
  private readonly heldKeys = new Set<string>()

  constructor(
    private readonly send: (input: BrowserLiveInput) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  pointerDown(event: PointerLike, rect: FrameRect): void {
    const point = at(rect, event.clientX, event.clientY)
    if (event.pointerType !== 'mouse') {
      this.touch = { startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, scrolling: false }
      return
    }
    const button = BUTTONS[event.button]
    if (!button) return
    this.flushMove()
    const clickCount = this.countClick(event)
    this.heldButtons.set(event.button, point)
    this.send({ kind: 'mouse', action: 'down', ...point, button, clickCount, modifiers: modifiersOf(event) })
  }

  pointerMove(event: PointerLike, rect: FrameRect): void {
    if (event.pointerType !== 'mouse') {
      this.dragTouch(event, rect)
      return
    }
    const point = at(rect, event.clientX, event.clientY)
    for (const held of this.heldButtons.values()) Object.assign(held, point)
    this.pendingMove = { kind: 'mouse', action: 'move', ...point, modifiers: modifiersOf(event) }
    const wait = FLUSH_MS - (this.now() - this.lastMoveAt)
    if (wait <= 0) this.flushMove()
    else this.moveTimer ??= setTimeout(() => this.flushMove(), wait)
  }

  pointerUp(event: PointerLike, rect: FrameRect): void {
    const point = at(rect, event.clientX, event.clientY)
    if (event.pointerType !== 'mouse') {
      const touch = this.touch
      this.touch = null
      if (!touch) return
      if (touch.scrolling) {
        this.flushScroll()
        return
      }
      // A tap is a click where the finger first landed, after a hover some pages wait for.
      const tap = at(rect, touch.startX, touch.startY)
      this.send({ kind: 'mouse', action: 'move', ...tap })
      this.send({ kind: 'mouse', action: 'down', ...tap, button: 'left', clickCount: 1 })
      this.send({ kind: 'mouse', action: 'up', ...tap, button: 'left', clickCount: 1 })
      return
    }
    const button = BUTTONS[event.button]
    if (!button || !this.heldButtons.delete(event.button)) return
    this.flushMove()
    this.send({ kind: 'mouse', action: 'up', ...point, button, clickCount: this.lastClick?.count ?? 1, modifiers: modifiersOf(event) })
  }

  /** The gesture was taken away (scrolling container, lost capture): nothing may stay pressed. */
  pointerCancel(): void {
    this.touch = null
    this.flushMove()
    this.releaseButtons()
  }

  wheel(event: WheelLike, rect: FrameRect): void {
    const scale = event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? rect.height : 1
    this.addScroll(
      at(rect, event.clientX, event.clientY),
      rect.width > 0 ? event.deltaX * scale / rect.width : 0,
      rect.height > 0 ? event.deltaY * scale / rect.height : 0
    )
  }

  /** Puts the page's first visible line at `top`, in the CSS pixels the frame's `scroll` reports. */
  scrollTo(top: number): void {
    this.pendingJump = { kind: 'scroll-to', top: Math.max(0, Math.round(top)) }
    const wait = FLUSH_MS - (this.now() - this.lastJumpAt)
    if (wait <= 0) this.flushJump()
    else this.jumpTimer ??= setTimeout(() => this.flushJump(), wait)
  }

  /** Returns whether the key was sent, which is when the caller must stop the browser acting on it. */
  keyDown(event: KeyLike): boolean {
    if (event.isComposing || NOT_KEYS.has(event.key) || LONE_MODIFIERS.has(event.key)) return false
    const shortcut = event.ctrlKey || event.metaKey
    // Pasting reads the viewer's clipboard, which the page's own shortcut cannot reach.
    if (shortcut && event.key.toLowerCase() === 'v') return false
    // Characters arrive as text, already composed by the viewer's input method.
    if (!shortcut && Array.from(event.key).length === 1) return false
    this.heldKeys.add(event.key)
    this.send({ kind: 'key', action: 'down', key: event.key, modifiers: modifiersOf(event) })
    return true
  }

  keyUp(event: KeyLike): boolean {
    if (!this.heldKeys.delete(event.key)) return false
    this.send({ kind: 'key', action: 'up', key: event.key, modifiers: modifiersOf(event) })
    return true
  }

  text(text: string): void {
    if (text) this.send({ kind: 'text', text: text.slice(0, MAX_TEXT_LENGTH) })
  }

  /** A key typed by the viewer's input method that has no text of its own. */
  press(key: string): void {
    this.send({ kind: 'key', action: 'down', key })
    this.send({ kind: 'key', action: 'up', key })
  }

  releaseKeys(): void {
    for (const key of this.heldKeys) this.send({ kind: 'key', action: 'up', key })
    this.heldKeys.clear()
  }

  dispose(): void {
    this.flushMove()
    this.flushScroll()
    this.flushJump()
    this.releaseButtons()
    this.releaseKeys()
  }

  private countClick(event: PointerLike): number {
    const now = this.now()
    const last = this.lastClick
    const repeat = last
      && now - last.at < MULTI_CLICK_MS
      && Math.abs(event.clientX - last.clientX) <= MULTI_CLICK_DISTANCE
      && Math.abs(event.clientY - last.clientY) <= MULTI_CLICK_DISTANCE
    const count = repeat ? Math.min(3, last.count + 1) : 1
    this.lastClick = { at: now, clientX: event.clientX, clientY: event.clientY, count }
    return count
  }

  private dragTouch(event: PointerLike, rect: FrameRect): void {
    const touch = this.touch
    if (!touch) return
    if (!touch.scrolling && Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) < TAP_SLOP) return
    touch.scrolling = true
    // The page follows the finger: dragging up reveals what is below.
    this.addScroll(
      at(rect, event.clientX, event.clientY),
      rect.width > 0 ? (touch.lastX - event.clientX) / rect.width : 0,
      rect.height > 0 ? (touch.lastY - event.clientY) / rect.height : 0
    )
    touch.lastX = event.clientX
    touch.lastY = event.clientY
  }

  private addScroll(point: { x: number; y: number }, deltaX: number, deltaY: number): void {
    if (!this.scroll) this.scroll = { ...point, deltaX: 0, deltaY: 0 }
    this.scroll.deltaX += deltaX
    this.scroll.deltaY += deltaY
    this.scrollTimer ??= setTimeout(() => this.flushScroll(), FLUSH_MS)
  }

  private flushScroll(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer)
    this.scrollTimer = null
    const scroll = this.scroll
    this.scroll = null
    if (scroll && (scroll.deltaX !== 0 || scroll.deltaY !== 0)) this.send({ kind: 'wheel', ...scroll })
  }

  private flushMove(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer)
    this.moveTimer = null
    const move = this.pendingMove
    this.pendingMove = null
    if (!move) return
    this.lastMoveAt = this.now()
    this.send(move)
  }

  private flushJump(): void {
    if (this.jumpTimer) clearTimeout(this.jumpTimer)
    this.jumpTimer = null
    const jump = this.pendingJump
    this.pendingJump = null
    if (!jump) return
    this.lastJumpAt = this.now()
    this.send(jump)
  }

  private releaseButtons(): void {
    for (const [index, point] of this.heldButtons) {
      this.send({ kind: 'mouse', action: 'up', ...point, button: BUTTONS[index] ?? 'left', clickCount: 1 })
    }
    this.heldButtons.clear()
  }
}
