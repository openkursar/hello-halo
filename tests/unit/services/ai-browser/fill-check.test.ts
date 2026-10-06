/**
 * browser_fill reports success only when the field holds the requested text.
 * Pages that block select-all (so new text lands after the old), mask or cut
 * the input, or refuse it get "the field reads X, not the requested Y" back;
 * a password field reports lengths only, and an element with nothing to read
 * is reported as unconfirmed rather than filled. Nothing is typed while focus
 * is somewhere else, where the text would land in another field.
 */

import { describe, expect, it, vi } from 'vitest'
import { FOCUS_REFUSED, READ_FILLED_VALUE, SELECT_IF_FOCUSED, checkFill } from '../../../../src/main/services/ai-browser/fill-check'
import type { FieldReadBack } from '../../../../src/main/services/ai-browser/types'
import type { BrowserContext } from '../../../../src/main/services/ai-browser/context'

vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}))

const { buildInputTools } = await import('../../../../src/main/services/ai-browser/tools/input')

// The page-side functions, run against stand-ins for DOM elements.
const readFilled = new Function(`return (${READ_FILLED_VALUE})`)() as (this: object) => Promise<FieldReadBack>
const selectIfFocused = new Function(`return (${SELECT_IF_FOCUSED})`)() as (this: object) => boolean

function field(value: string, type = 'text'): Record<string, unknown> {
  return { value, type, isContentEditable: false, ownerDocument: { activeElement: null } }
}

describe('typing only where focus is', () => {
  function page(): { doc: Record<string, unknown>; body: Record<string, unknown>; execCommand: ReturnType<typeof vi.fn> } {
    const execCommand = vi.fn()
    const doc: Record<string, unknown> = { execCommand, parentNode: null }
    const body: Record<string, unknown> = { parentNode: doc, isContentEditable: false }
    doc.activeElement = body
    return { doc, body, execCommand }
  }
  function element(doc: Record<string, unknown>, parentNode: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ownerDocument: doc, parentNode, getRootNode: () => doc, isContentEditable: false, ...extra }
  }

  it('selects the text of the focused field', () => {
    const { doc, body, execCommand } = page()
    const input = element(doc, body)
    doc.activeElement = input
    expect(selectIfFocused.call(input)).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('selectAll')
  })

  it('accepts focus inside the element, or on the editing host or shadow host around it', () => {
    const { doc, body } = page()
    const wrapper = element(doc, body)
    const shadowRoot: Record<string, unknown> = { parentNode: null, host: wrapper }
    const inner = { parentNode: shadowRoot }
    shadowRoot.activeElement = inner
    wrapper.shadowRoot = shadowRoot
    doc.activeElement = wrapper
    expect(selectIfFocused.call(wrapper)).toBe(true)

    const editor = element(doc, body, { isContentEditable: true })
    const paragraph = element(doc, editor, { isContentEditable: true })
    doc.activeElement = editor
    expect(selectIfFocused.call(paragraph)).toBe(true)

    // A closed shadow root hides its focused input: focus shows as its host.
    const host = element(doc, body)
    const closedRoot = { parentNode: null, host }
    const field = element(doc, closedRoot, { getRootNode: () => closedRoot })
    doc.activeElement = host
    expect(selectIfFocused.call(field)).toBe(true)
  })

  it('types into a rich-text editor in a frame only while the page has focus on that frame', () => {
    // The page: a password field and an editor frame (rich-text editors often live in an iframe).
    const { doc: topDoc, body: topBody } = page()
    const password = element(topDoc, topBody, { type: 'password' })
    const frame = element(topDoc, topBody)
    const topWindow = { frameElement: null }
    // Inside the frame nothing is focused, so its editable body reports itself as active.
    const execCommand = vi.fn()
    const frameDoc: Record<string, unknown> = { execCommand, parentNode: null, defaultView: { frameElement: frame, parent: topWindow } }
    const editorBody = element(frameDoc, frameDoc, { isContentEditable: true })
    const paragraph = element(frameDoc, editorBody, { isContentEditable: true })
    frameDoc.activeElement = editorBody

    topDoc.activeElement = password
    expect(selectIfFocused.call(paragraph)).toBe(false)
    expect(execCommand).not.toHaveBeenCalled()

    topDoc.activeElement = frame
    expect(selectIfFocused.call(paragraph)).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('selectAll')
  })

  it('points to a snapshot when it types nothing, so a field that hands focus to a popup is not retried in a loop', () => {
    expect(FOCUS_REFUSED).toMatch(/^focus stayed on another element, so nothing was typed\. Take a browser_snapshot/)
  })

  it('types nothing while focus stays on another field, or on nothing at all', () => {
    const { doc, body, execCommand } = page()
    const editor = element(doc, body, { isContentEditable: true })
    const paragraph = element(doc, editor, { isContentEditable: true })
    doc.activeElement = element(doc, body, { type: 'password' })
    expect(selectIfFocused.call(paragraph)).toBe(false)

    doc.activeElement = body
    expect(selectIfFocused.call(element(doc, body))).toBe(false)
    expect(execCommand).not.toHaveBeenCalled()
  })
})

describe('reading a filled element back on the page', () => {
  it('reads an input, flagging a password field', async () => {
    expect(await readFilled.call(field('ABC'))).toEqual({ kind: 'field', value: 'ABC', secret: false })
    expect(await readFilled.call(field('hunter2', 'password'))).toEqual({ kind: 'field', value: 'hunter2', secret: true })
  })

  it('reads after input handlers that reformat on a later task', async () => {
    const input = field('13800138000')
    setTimeout(() => { input.value = '138-0013-8000' }, 0)
    expect(await readFilled.call(input)).toEqual({ kind: 'field', value: '138-0013-8000', secret: false })
  })

  it('reads a rich-text child from its whole editing host', async () => {
    const host = { isContentEditable: true, innerText: 'Hello\u00a0world\n', parentElement: { isContentEditable: false } }
    const paragraph = { isContentEditable: true, innerText: 'Hello', parentElement: host }
    expect(await readFilled.call(paragraph)).toEqual({ kind: 'editable', value: 'Hello\u00a0world\n' })
  })

  it('answers unreadable instead of hanging when the element cannot be inspected', async () => {
    expect(await readFilled.call({ isContentEditable: false })).toEqual({ kind: 'unreadable' })
  })

  it('follows focus into a field inside the element, never to a field elsewhere', async () => {
    const wrapper: Record<string, unknown> = { isContentEditable: false }
    const shadowRoot: Record<string, unknown> = { parentNode: null, host: wrapper }
    const inner = { value: '42', type: 'text', parentNode: shadowRoot }
    shadowRoot.activeElement = inner
    wrapper.shadowRoot = shadowRoot
    wrapper.ownerDocument = { activeElement: wrapper }
    expect(await readFilled.call(wrapper)).toEqual({ kind: 'field', value: '42', secret: false })

    const other = { value: 'typed here instead', type: 'text', parentNode: { parentNode: null } }
    const label = { isContentEditable: false, ownerDocument: { activeElement: other } }
    expect(await readFilled.call(label)).toEqual({ kind: 'unreadable' })
  })
})

describe('comparing what the field holds with the requested text', () => {
  it('confirms a plain input that holds the value', () => {
    expect(checkFill('alice@example.com', { kind: 'field', value: 'alice@example.com', secret: false })).toEqual({ status: 'match' })
  })

  it('reports text appended to the old value when the page blocked select-all', () => {
    const check = checkFill('ABC', { kind: 'field', value: 'ABCABC', secret: false })
    expect(check.status).toBe('different')
    expect(check.status === 'different' && check.detail).toMatch(/^the field reads "ABCABC", not the requested "ABC"\./)
  })

  it('reports what an input mask or a length limit left, for the model to judge', () => {
    const masked = checkFill('13800138000', { kind: 'field', value: '138-0013-8000', secret: false })
    expect(masked.status === 'different' && masked.detail).toMatch(/^the field reads "138-0013-8000", not the requested "13800138000"\..*only the page's formatting/)
    expect(checkFill('ABCDEF', { kind: 'field', value: 'ABCD', secret: false }).status).toBe('different')
  })

  it('compares rich text without the spacing editors add, and still catches appended text', () => {
    expect(checkFill('Hello world', { kind: 'editable', value: 'Hello\u00a0world\u200b\n' })).toEqual({ status: 'match' })
    expect(checkFill('Hello world', { kind: 'editable', value: 'Hello worldHello world' }).status).toBe('different')
  })

  it('treats the line breaks a text area reports as the requested ones', () => {
    expect(checkFill('line 1\r\nline 2', { kind: 'field', value: 'line 1\nline 2', secret: false })).toEqual({ status: 'match' })
  })

  it('never repeats a password, only its length', () => {
    const check = checkFill('hunter2', { kind: 'field', value: 'hunter2hunter2', secret: true })
    const detail = check.status === 'different' ? check.detail : ''
    expect(detail).toMatch(/^the password field does not hold the requested text \(it has 14 characters, 7 were requested\)/)
    expect(detail).not.toContain('hunter2')
  })

  it('quotes a long value only in part', () => {
    const check = checkFill('short', { kind: 'field', value: 'x'.repeat(5000), secret: false })
    const detail = check.status === 'different' ? check.detail : ''
    expect(detail).toContain('… (5000 characters)')
    expect(detail.length).toBeLessThan(800)
  })

  it('calls an element with nothing to read unconfirmed', () => {
    expect(checkFill('ABC', { kind: 'unreadable' }).status).toBe('unreadable')
  })
})

describe('browser_fill results', () => {
  const holds = new Map<string, FieldReadBack>([
    ['token', { kind: 'field', value: 'ABCABC', secret: false }],
    ['widget', { kind: 'unreadable' }],
  ])
  const ctx = {
    getActiveViewId: () => 'page',
    getElementByUid: (uid: string) => uid === 'country'
      ? { role: 'combobox', children: [{ role: 'option', name: 'France' }] }
      : { role: 'textbox' },
    fillElement: async (uid: string, value: string): Promise<FieldReadBack> => holds.get(uid) ?? { kind: 'field', value, secret: false },
    selectOption: async () => {},
  } as unknown as BrowserContext
  const fill = (buildInputTools(ctx).find((t) => (t as unknown as { name: string }).name === 'browser_fill') as unknown as {
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  }).handler

  it('succeeds only for a field that holds the value', async () => {
    expect(await fill({ uid: 'user', value: 'alice' })).toEqual({ content: [{ type: 'text', text: 'Successfully filled the element.' }] })

    const appended = await fill({ uid: 'token', value: 'ABC' })
    expect(appended.isError).toBe(true)
    expect(appended.content[0].text).toMatch(/^Filled token, but the field reads "ABCABC", not the requested "ABC"\./)

    const unread = await fill({ uid: 'widget', value: 'x' })
    expect(unread.isError).toBeUndefined()
    expect(unread.content[0].text).toMatch(/^Typed into widget, but this element has no value to read back/)
  })

  it('checks every field of a batch', async () => {
    const mixed = await fill({ elements: [{ uid: 'user', value: 'alice' }, { uid: 'token', value: 'ABC' }, { uid: 'country', value: 'France' }] })
    expect(mixed.isError).toBeUndefined()
    expect(mixed.content[0].text).toMatch(/^Partially filled form \(2\/3 succeeded\)\.\n\nErrors:\ntoken: the field reads "ABCABC", not the requested "ABC"\./)

    const unread = await fill({ elements: [{ uid: 'user', value: 'alice' }, { uid: 'widget', value: 'x' }] })
    expect(unread.content[0].text).toMatch(/^Filled 2 form fields; 1 could not be read back\.\n\nUnconfirmed:\nwidget: this element has no value/)

    expect(await fill({ elements: [{ uid: 'user', value: 'alice' }, { uid: 'country', value: 'France' }] }))
      .toEqual({ content: [{ type: 'text', text: 'Successfully filled 2 form fields.' }] })
  })
})
