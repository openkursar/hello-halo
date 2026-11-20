import type { MouseInputEvent, WebContents } from 'electron'
import { dispatchBrowserKeyboard, dispatchBrowserText } from '../browser-input'
import { runPageScript } from './page-script'
import type { BrowserLiveInput, BrowserLiveModifier } from '../../../shared/types/browser-live'

/** The page's size in DIP, which is what native input coordinates are measured in. */
export interface BrowserLiveViewport {
  width: number
  height: number
}

const MODIFIERS: readonly BrowserLiveModifier[] = ['shift', 'control', 'alt', 'meta']
const BUTTONS = ['left', 'middle', 'right'] as const
const MODIFIER_MASK: Record<BrowserLiveModifier, number> = { alt: 1, control: 2, meta: 4, shift: 8 }
const MAX_TEXT_LENGTH = 10_000
const MAX_KEY_LENGTH = 32
/** Far beyond any real document; only keeps the number sane. */
const MAX_SCROLL_TOP = 10_000_000

function fraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null
}

/** A wheel delta is a fraction of the frame; more than a few frames per event is noise. */
function wheelDelta(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(5, Math.max(-5, value)) : null
}

function modifiersOf(value: unknown): BrowserLiveModifier[] {
  return Array.isArray(value) ? MODIFIERS.filter(modifier => value.includes(modifier)) : []
}

/** Turns an untrusted viewer payload into a well-formed input, or null. */
export function parseBrowserLiveInput(raw: unknown): BrowserLiveInput | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  switch (input.kind) {
    case 'mouse': {
      const x = fraction(input.x)
      const y = fraction(input.y)
      const action = input.action
      if (x === null || y === null || (action !== 'down' && action !== 'up' && action !== 'move')) return null
      const clickCount = typeof input.clickCount === 'number' && input.clickCount >= 1 && input.clickCount <= 3
        ? Math.floor(input.clickCount)
        : 1
      return {
        kind: 'mouse', action, x, y, clickCount,
        button: BUTTONS.find(button => button === input.button) ?? 'left',
        modifiers: modifiersOf(input.modifiers),
      }
    }
    case 'wheel': {
      const x = fraction(input.x)
      const y = fraction(input.y)
      const deltaX = wheelDelta(input.deltaX)
      const deltaY = wheelDelta(input.deltaY)
      if (x === null || y === null || deltaX === null || deltaY === null) return null
      return { kind: 'wheel', x, y, deltaX, deltaY }
    }
    case 'key': {
      const key = input.key
      if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) return null
      if (input.action !== 'down' && input.action !== 'up') return null
      const modifiers = modifiersOf(input.modifiers)
      const shortcut = modifiers.includes('control') || modifiers.includes('meta')
      // Paste uses the client clipboard through the text message, never the host's.
      if ((shortcut && /^[cvx]$/i.test(key)) ||
          (key === 'Insert' && (shortcut || modifiers.includes('shift'))) ||
          (key === 'Delete' && modifiers.includes('shift'))) return null
      return { kind: 'key', action: input.action, key, modifiers }
    }
    case 'text': {
      const text = input.text
      if (typeof text !== 'string' || !text || text.length > MAX_TEXT_LENGTH) return null
      return { kind: 'text', text }
    }
    case 'scroll-to': {
      const top = input.top
      if (typeof top !== 'number' || !Number.isFinite(top)) return null
      return { kind: 'scroll-to', top: Math.round(Math.min(MAX_SCROLL_TOP, Math.max(0, top))) }
    }
  }
  return null
}

/** Whether the input can change what the page shows, as opposed to merely hovering. */
export function changesPage(input: BrowserLiveInput): boolean {
  return !(input.kind === 'mouse' && input.action === 'move')
}

/**
 * What one viewer currently holds pressed on the page, so a viewer that leaves
 * mid-drag or mid-keypress does not leave the page with a stuck key or button.
 */
export class BrowserLiveInputState {
  private readonly keys = new Map<string, number>()
  private readonly buttons = new Map<MouseInputEvent['button'] & string, { x: number; y: number }>()

  constructor(private readonly contents: WebContents) {}

  async dispatch(input: BrowserLiveInput, viewport: BrowserLiveViewport): Promise<void> {
    if (this.contents.isDestroyed()) return
    switch (input.kind) {
      case 'mouse': {
        const x = Math.round(input.x * viewport.width)
        const y = Math.round(input.y * viewport.height)
        const button = input.button ?? 'left'
        if (input.action === 'move') {
          this.contents.sendInputEvent({ type: 'mouseMove', x, y, modifiers: this.withHeldButtons(input.modifiers) })
          for (const held of this.buttons.values()) Object.assign(held, { x, y })
          return
        }
        const type = input.action === 'down' ? 'mouseDown' : 'mouseUp'
        this.contents.sendInputEvent({ type, x, y, button, clickCount: input.clickCount ?? 1, modifiers: input.modifiers })
        if (input.action === 'down') this.buttons.set(button, { x, y })
        else this.buttons.delete(button)
        return
      }
      case 'wheel': {
        // Native wheel deltas point the way the content moves, opposite to DOM's.
        this.contents.sendInputEvent({
          type: 'mouseWheel',
          x: Math.round(input.x * viewport.width),
          y: Math.round(input.y * viewport.height),
          deltaX: -Math.round(input.deltaX * viewport.width),
          deltaY: -Math.round(input.deltaY * viewport.height),
          canScroll: true,
        })
        return
      }
      case 'key': {
        const mask = keyModifierMask(input.modifiers)
        await dispatchBrowserKeyboard(this.contents, { type: input.action === 'down' ? 'keyDown' : 'keyUp', key: input.key, modifiers: mask })
        if (input.action === 'down') this.keys.set(input.key, mask)
        else this.keys.delete(input.key)
        return
      }
      case 'text':
        await dispatchBrowserText(this.contents, input.text)
        return
      case 'scroll-to':
        // Instant, so a page styled for smooth scrolling lands before the next frame.
        await runPageScript(this.contents, `scrollTo({ top: ${input.top}, behavior: 'instant' })`)
    }
  }

  /** Lifts everything this viewer still holds; safe to call on a closed page. */
  async release(): Promise<void> {
    const keys = Array.from(this.keys)
    const buttons = Array.from(this.buttons)
    this.keys.clear()
    this.buttons.clear()
    if (this.contents.isDestroyed()) return
    for (const [button, { x, y }] of buttons) {
      this.contents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 })
    }
    for (const [key, modifiers] of keys) {
      await dispatchBrowserKeyboard(this.contents, { type: 'keyUp', key, modifiers })
    }
  }

  private withHeldButtons(modifiers: BrowserLiveModifier[] = []): MouseInputEvent['modifiers'] {
    const held = Array.from(this.buttons.keys()).map(button => `${button}buttondown` as const)
    return [...modifiers, ...held]
  }
}

/**
 * The viewer's Command key is the server's Control key unless the server is a
 * Mac, so shortcuts typed on a Mac still edit a page served from Linux.
 */
function keyModifierMask(modifiers: BrowserLiveModifier[] = []): number {
  const mapped = process.platform === 'darwin' ? modifiers : modifiers.map(modifier => modifier === 'meta' ? 'control' : modifier)
  return Array.from(new Set(mapped)).reduce((mask, modifier) => mask | MODIFIER_MASK[modifier], 0)
}
