import type { WebContents, KeyboardInputEvent } from 'electron'
import { clipboard } from 'electron'
import type { BrowserInputCommandSender, BrowserInputScope, BrowserInputTarget } from './target'

interface RemoteResult<T> {
  result: { objectId?: string; value?: T }
  exceptionDetails?: unknown
}

interface BrowserKeyboardOptions {
  scope?: BrowserInputScope
  onDispatched?: () => void
}

const KEY_CODES: Record<string, string> = {
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space',
}

const CHARACTER_KEY_PAIRS = [
  ['0', ')', 'Digit0', 48], ['1', '!', 'Digit1', 49], ['2', '@', 'Digit2', 50],
  ['3', '#', 'Digit3', 51], ['4', '$', 'Digit4', 52], ['5', '%', 'Digit5', 53],
  ['6', '^', 'Digit6', 54], ['7', '&', 'Digit7', 55], ['8', '*', 'Digit8', 56], ['9', '(', 'Digit9', 57],
  [';', ':', 'Semicolon', 186], ['=', '+', 'Equal', 187], [',', '<', 'Comma', 188],
  ['-', '_', 'Minus', 189], ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192], ['[', '{', 'BracketLeft', 219], ['\\', '|', 'Backslash', 220],
  [']', '}', 'BracketRight', 221], ["'", '"', 'Quote', 222],
] as const

function characterKey(key: string): { code: string; virtualCode: number; shifted: boolean; shiftedText: string } | undefined {
  if (/^[a-z]$/i.test(key)) return { code: `Key${key.toUpperCase()}`, virtualCode: key.toUpperCase().charCodeAt(0), shifted: false, shiftedText: key.toUpperCase() }
  const pair = CHARACTER_KEY_PAIRS.find(([plain, shifted]) => key === plain || key === shifted)
  return pair ? { code: pair[2], virtualCode: pair[3], shifted: key === pair[1], shiftedText: pair[1] } : undefined
}

function printableText(value: unknown): string | undefined {
  if (typeof value !== 'string' || Array.from(value).length !== 1) return
  const code = value.codePointAt(0)!
  return code >= 32 && !(code >= 127 && code <= 159) ? value : undefined
}

function characterText(key: string, value: unknown, shifted: boolean): string | undefined {
  if (key === 'Enter') return '\r'
  const text = printableText(value) ?? printableText(key)
  return shifted && text === key ? characterKey(key)?.shiftedText ?? text : text
}

const FOCUSED_DOCUMENT = `(() => {
  let owner = document;
  let target = owner.activeElement;
  while (target) {
    if (target.shadowRoot?.activeElement) { target = target.shadowRoot.activeElement; continue; }
    if (target.tagName === 'IFRAME') {
      const child = target.contentDocument;
      if (child) { owner = child; target = owner.activeElement; continue; }
    }
    break;
  }
  return {owner, target};
})()`

function nativeModifiers(value: unknown): NonNullable<KeyboardInputEvent['modifiers']> {
  const mask = typeof value === 'number' ? value : 0
  const modifiers: NonNullable<KeyboardInputEvent['modifiers']> = []
  if (mask & 1) modifiers.push('alt')
  if (mask & 2) modifiers.push('control')
  if (mask & 4) modifiers.push('meta')
  if (mask & 8) modifiers.push('shift')
  return modifiers
}

function editingCommand(key: string, modifiers: KeyboardInputEvent['modifiers']): string | undefined {
  if (process.platform !== 'darwin' || !modifiers?.includes('meta') || modifiers.includes('alt') || modifiers.includes('control')) return
  const commands: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' }
  const command = commands[key.toLowerCase()]
  if (modifiers.includes('shift')) return command === 'undo' ? 'redo' : command === 'paste' ? 'pasteAndMatchStyle' : undefined
  return command
}

async function executeEditingCommand(send: BrowserInputCommandSender, command: string): Promise<void> {
  let expression: string
  if (command === 'paste' || command === 'pasteAndMatchStyle') {
    const text = clipboard.readText()
    const html = command === 'paste' ? clipboard.readHTML() : ''
    const image = command === 'paste' ? clipboard.readImage() : undefined
    const png = image && !image.isEmpty() ? image.toPNG().toString('base64') : ''
    expression = `(() => {
      const data = ${JSON.stringify({ text, html, png })};
      const {owner, target} = ${FOCUSED_DOCUMENT};
      if (!target) return;
      const realm = owner.defaultView;
      const transfer = new realm.DataTransfer();
      if (data.text) transfer.setData('text/plain', data.text);
      if (data.html) transfer.setData('text/html', data.html);
      if (data.png) transfer.items.add(new realm.File([realm.Uint8Array.from(realm.atob(data.png), c => c.charCodeAt(0))], 'image.png', {type:'image/png'}));
      if (!target.dispatchEvent(new realm.ClipboardEvent('paste', {clipboardData:transfer,bubbles:true,cancelable:true,composed:true}))) return;
      const markup = data.html || (data.png ? '<img src="data:image/png;base64,' + data.png + '">' : '');
      const inserted = owner.execCommand(markup && target.isContentEditable ? 'insertHTML' : 'insertText', false, markup && target.isContentEditable ? markup : data.text);
      const editable = target.isContentEditable || ((target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && !target.readOnly && !target.disabled);
      if (editable && !inserted) throw new Error('Browser page refused clipboard insertion');
    })()`
  } else {
    expression = `(${FOCUSED_DOCUMENT}).owner.execCommand(${JSON.stringify(command)})`
  }
  const result = await send<RemoteResult<unknown>>('Runtime.evaluate', { expression, userGesture: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error('Browser editing command failed')
}

async function dispatchAcknowledgedKey(
  contents: WebContents,
  event: KeyboardInputEvent,
  code: string,
  key: string,
  send: BrowserInputCommandSender,
  assertActive: () => void,
  options: BrowserKeyboardOptions,
  target: BrowserInputTarget
): Promise<boolean> {
  const eventType = event.type === 'keyUp' ? 'keyup' : 'keydown'
  const expression = {
    expression: `(() => {
      const owner = (${FOCUSED_DOCUMENT}).owner.defaultView;
      let finish;
      let timer;
      let eventTimer;
      let settled = false;
      const cleanup = () => { owner.removeEventListener(${JSON.stringify(eventType)}, listener, true); clearTimeout(timer); clearTimeout(eventTimer); };
      const settle = prevented => { if (settled) return; settled = true; cleanup(); finish(prevented); };
      const dispose = () => settle(true);
      const listener = event => {
        if (!event.isTrusted || (event.code !== ${JSON.stringify(code)} && event.key.toLowerCase() !== ${JSON.stringify(key.toLowerCase())})) return;
        if (event.altKey !== ${event.modifiers?.includes('alt') ?? false} || event.ctrlKey !== ${event.modifiers?.includes('control') ?? false} || event.metaKey !== ${event.modifiers?.includes('meta') ?? false} || event.shiftKey !== ${event.modifiers?.includes('shift') ?? false}) return;
        if (eventTimer !== undefined) return;
        eventTimer = setTimeout(() => settle(event.defaultPrevented), 0);
      };
      const promise = new Promise((resolve, reject) => {
        finish = resolve;
        timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); reject(new Error('Browser key acknowledgement timed out')); }, 15000);
        owner.addEventListener(${JSON.stringify(eventType)}, listener, true);
      });
      promise.catch(() => {});
      return {promise, dispose};
    })()`,
  }
  const prepared = options.scope
    ? await options.scope.evaluateResource<boolean>({ ...expression, contextId: target.contextId }, target.sessionId, true)
    : await send<RemoteResult<boolean>>('Runtime.evaluate', expression)
  const objectId = prepared.result.objectId
  if (!objectId || prepared.exceptionDetails) throw new Error('Browser key acknowledgement could not be prepared')
  try {
    assertActive()
    contents.sendInputEvent(event)
    options.onDispatched?.()
    const acknowledged = await send<RemoteResult<boolean>>('Runtime.callFunctionOn', {
      objectId, functionDeclaration: 'function() { return this.promise }', awaitPromise: true, returnByValue: true,
    })
    assertActive()
    if (acknowledged.exceptionDetails) throw new Error('Browser key acknowledgement failed')
    return acknowledged.result.value === true
  } finally {
    if (options.scope) {
      await options.scope.releaseResource(objectId, target.sessionId)
    } else {
      void contents.debugger.sendCommand('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.dispose() }' })
        .then(() => contents.debugger.sendCommand('Runtime.releaseObject', { objectId }))
        .catch(error => { if (!contents.isDestroyed()) console.warn('[BrowserInput] Failed to release key acknowledgement', { contentsId: contents.id }, error) })
    }
  }
}

function targetSender(sender: BrowserInputCommandSender, target: BrowserInputTarget): BrowserInputCommandSender {
  return (method, params) => {
    const scopedParams = method === 'Runtime.evaluate' && target.contextId !== undefined ? { ...params, contextId: target.contextId } : params
    return target.sessionId === undefined ? sender(method, scopedParams) : sender(method, scopedParams, target.sessionId)
  }
}

function virtualKeyCode(key: string): number | undefined {
  const codes: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27,
    ' ': 32, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91,
  }
  if (codes[key] !== undefined) return codes[key]
  const character = characterKey(key)
  if (character) return character.virtualCode
  const functionKey = /^F([1-9]|1\d|2[0-4])$/.exec(key)
  return functionKey ? 111 + Number(functionKey[1]) : undefined
}

/** CDP keyboard dispatch selects the outer focused widget; native events address this guest directly. */
export async function dispatchBrowserKeyboard(
  contents: WebContents,
  params: Record<string, unknown>,
  sender?: BrowserInputCommandSender,
  assertActive: () => void = () => {},
  options: BrowserKeyboardOptions = {}
): Promise<void> {
  assertActive()
  const type = params.type
  const requestedKey = typeof params.key === 'string' ? params.key : typeof params.code === 'string' ? params.code : ''
  const key = requestedKey === 'Plus' ? '+' : requestedKey
  if (!key && type !== 'char') throw new Error('Browser key event requires a key')
  const character = characterKey(key)
  const modifierMask = (typeof params.modifiers === 'number' ? params.modifiers : 0) | (character?.shifted ? 8 : 0)
  const modifiers = nativeModifiers(modifierMask)
  const code = character?.code ?? (typeof params.code === 'string' ? params.code : key)
  if (type === 'char') {
    await dispatchBrowserText(contents, typeof params.text === 'string' ? params.text : key, sender, assertActive, options.scope)
    return
  }
  if (type !== 'keyDown' && type !== 'rawKeyDown' && type !== 'keyUp') throw new Error('Unsupported browser key event type')
  const event: KeyboardInputEvent = { type: type === 'keyUp' ? 'keyUp' : 'keyDown', keyCode: KEY_CODES[key] ?? key, modifiers }
  const command = type === 'keyUp' ? undefined : editingCommand(key, modifiers)
  const target = options.scope ? await options.scope.resolveTarget() : {}
  assertActive()
  const send: BrowserInputCommandSender = sender ?? ((method, value, sessionId) => sessionId === undefined
    ? contents.debugger.sendCommand(method, value) : contents.debugger.sendCommand(method, value, sessionId))
  const scopedSend = targetSender(send, target)
  if (target.sessionId) {
    const text = type === 'keyUp' || command || modifiers?.some(value => value === 'control' || value === 'meta' || value === 'alt')
      ? undefined : characterText(key, params.text, modifiers.includes('shift'))
    await send('Input.dispatchKeyEvent', {
      ...params, key, code, ...(modifierMask !== (params.modifiers ?? 0) ? { modifiers: modifierMask } : {}),
      text, windowsVirtualKeyCode: virtualKeyCode(key), commands: command ? [command] : undefined,
    }, target.sessionId)
    return
  }
  if (command) {
    // macOS menu commands need OS events unavailable here; preserve the page's trusted handler before supplying the default.
    const prevented = await dispatchAcknowledgedKey(contents, event, code, key, scopedSend, assertActive, options, target)
    if (!prevented) await executeEditingCommand(scopedSend, command)
  } else if (type === 'keyUp' && sender) {
    // Native dispatch returns before the renderer consumes input; keep its frames until the sequence has finished.
    await dispatchAcknowledgedKey(contents, event, code, key, scopedSend, assertActive, options, target)
  } else {
    contents.sendInputEvent(event)
    options.onDispatched?.()
  }
  if (type !== 'keyUp' && !modifiers?.includes('control') && !modifiers?.includes('meta') && !modifiers?.includes('alt')) {
    const text = characterText(key, params.text, modifiers.includes('shift'))
    if (text) contents.sendInputEvent({ type: 'char', keyCode: text, modifiers })
  }
}

export async function dispatchBrowserText(
  contents: WebContents,
  text: string,
  sender?: BrowserInputCommandSender,
  assertActive: () => void = () => {},
  scope?: BrowserInputScope
): Promise<void> {
  assertActive()
  const target = scope ? await scope.resolveTarget() : {}
  assertActive()
  if (target.sessionId && sender) await sender('Input.insertText', { text }, target.sessionId)
  else await contents.insertText(text)
}
