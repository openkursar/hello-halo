import type { WebContents } from 'electron'
import { dispatchBrowserKeyboard, dispatchBrowserText } from './keyboard'
import { createBrowserInputScope, type BrowserInputCommandSender, type BrowserInputScope } from './target'

export const BROWSER_INPUT_METHODS = new Set(['Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchMouseEvent'])

interface PressedKey {
  params: Record<string, unknown>
  sessionId?: string
  release?: Promise<unknown>
}

interface PressedButton {
  touch?: boolean
  sessionId?: string
  [key: string]: unknown
}

/**
 * Input sent during one page operation. It records what the page saw pressed,
 * so `release()` can lift every key and button on the original page even when
 * the operation is cancelled or times out midway.
 */
export class BrowserInputOperation {
  private scope?: BrowserInputScope
  private readonly keys = new Map<string, PressedKey>()
  private readonly buttons = new Map<string, PressedButton>()

  constructor(
    private readonly contents: WebContents,
    private readonly sender: BrowserInputCommandSender,
    private readonly assertActive: () => void,
    /** When true, left clicks are dispatched as touch events (page without mouse-to-touch emulation). */
    private readonly emulateTouch?: () => boolean,
  ) {}

  isKeyPressed(key: string): boolean {
    return this.keys.has(key)
  }

  /** Dispatches one CDP-shaped input command; see {@link BROWSER_INPUT_METHODS}. */
  async dispatch(method: string, params: Record<string, unknown>, sessionId?: string): Promise<void> {
    if (method === 'Input.dispatchKeyEvent') return this.dispatchKey(params, sessionId)
    if (method === 'Input.insertText') return this.insertText(params, sessionId)
    if (method === 'Input.dispatchMouseEvent') return this.dispatchMouse(params, sessionId)
    throw new Error(`Unsupported browser input command: ${method}`)
  }

  /** Lifts everything still pressed, then closes the operation's frame resources. */
  async release(): Promise<void> {
    if (this.contents.isDestroyed()) return
    const commands: Array<Promise<unknown>> = []
    for (const event of this.keys.values()) {
      const lift = () => event.sessionId
        ? this.contents.debugger.sendCommand('Input.dispatchKeyEvent', { ...event.params, type: 'keyUp', text: undefined, commands: undefined }, event.sessionId)
        : dispatchBrowserKeyboard(this.contents, { ...event.params, type: 'keyUp', text: undefined })
      commands.push(event.release ? event.release.catch(lift) : lift())
    }
    for (const event of this.buttons.values()) {
      commands.push(event.touch === true
        ? this.contents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, event.sessionId)
        : this.contents.debugger.sendCommand('Input.dispatchMouseEvent', { ...event, type: 'mouseReleased' }))
    }
    this.keys.clear()
    this.buttons.clear()
    try {
      await Promise.all(commands)
    } finally {
      await this.dispose()
    }
  }

  dispose(): Promise<void> {
    return this.scope?.dispose() ?? Promise.resolve()
  }

  private inputScope(): BrowserInputScope {
    this.scope ??= createBrowserInputScope(this.contents, this.sender, this.assertActive)
    return this.scope
  }

  private async dispatchKey(params: Record<string, unknown>, sessionId?: string): Promise<void> {
    const type = params.type
    const key = String(params.code ?? params.key ?? '')
    if (!sessionId) {
      await dispatchBrowserKeyboard(this.contents, params, this.sender, this.assertActive, {
        scope: this.inputScope(),
        onDispatched: () => {
          if (type === 'keyDown' || type === 'rawKeyDown') this.keys.set(key, { params: { ...params } })
          if (type === 'keyUp') this.keys.delete(key)
        },
      })
      return
    }
    const request = this.contents.debugger.sendCommand('Input.dispatchKeyEvent', params, sessionId)
    if (type === 'keyDown' || type === 'rawKeyDown') {
      const pressed: PressedKey = { params: { ...params }, sessionId }
      this.keys.set(key, pressed)
      // A rejected key-down never reached the page, so cleanup must not lift it.
      request.catch(() => { if (this.keys.get(key) === pressed) this.keys.delete(key) })
      await request
      return
    }
    const pressed = this.keys.get(key)
    if (type === 'keyUp' && pressed) {
      pressed.release = request.then(result => {
        if (this.keys.get(key) === pressed) this.keys.delete(key)
        return result
      })
      await pressed.release
      return
    }
    await request
  }

  private async insertText(params: Record<string, unknown>, sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.contents.debugger.sendCommand('Input.insertText', params, sessionId)
      return
    }
    await dispatchBrowserText(this.contents, typeof params.text === 'string' ? params.text : '', this.sender, this.assertActive, this.inputScope())
  }

  private async dispatchMouse(params: Record<string, unknown>, sessionId?: string): Promise<void> {
    const type = params.type
    const button = String(params.button ?? 'left')
    // Once a press becomes touch, its whole press-move-release cycle stays touch
    // even if the emulation predicate flips midway.
    const touchLifecycle = (type === 'mousePressed' || type === 'mouseMoved' || type === 'mouseReleased') &&
      (this.buttons.get(button)?.touch === true || (type === 'mousePressed' && button === 'left' && !!this.emulateTouch?.()))
    if (touchLifecycle) return this.dispatchTouchFromMouse(params, button, sessionId)
    const request = this.contents.debugger.sendCommand('Input.dispatchMouseEvent', params, sessionId)
    if (type === 'mousePressed') {
      const pressed = { ...params }
      this.buttons.set(button, pressed)
      // A rejected press never reached the page, so cleanup must not release it.
      request.catch(() => { if (this.buttons.get(button) === pressed) this.buttons.delete(button) })
    } else if (type === 'mouseMoved' && this.buttons.has(button)) {
      this.buttons.set(button, { ...params })
    }
    await request
    if (type === 'mouseReleased') this.buttons.delete(button)
  }

  /**
   * Left clicks for a page without mouse-to-touch emulation: deliver real touch
   * events (Puppeteer touchScreen mechanism) so mobile pages still see the
   * gestures they detect. Hover moves, wheel and non-left buttons stay mouse.
   */
  private async dispatchTouchFromMouse(params: Record<string, unknown>, button: string, sessionId?: string): Promise<void> {
    const type = params.type
    const command = this.contents.debugger.sendCommand('Input.dispatchTouchEvent', {
      type: type === 'mousePressed' ? 'touchStart' : type === 'mouseMoved' ? 'touchMove' : 'touchEnd',
      touchPoints: type === 'mouseReleased' ? [] : [{ x: params.x, y: params.y }],
    }, sessionId)
    if (type === 'mousePressed') {
      const pressed: PressedButton = { touch: true, sessionId }
      this.buttons.set(button, pressed)
      // A rejected touch never reached the page, so cleanup must not end it.
      command.catch(() => { if (this.buttons.get(button) === pressed) this.buttons.delete(button) })
      await command
      return
    }
    await command
    if (type === 'mouseReleased') this.buttons.delete(button)
  }
}
