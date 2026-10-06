import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: {} }))

const { BrowserInputOperation } = await import('../../../src/main/services/browser-input')

function contents(reject: (method: string, params: Record<string, unknown>) => boolean = () => false) {
  const sendCommand = vi.fn((method: string, params: Record<string, unknown>) =>
    reject(method, params) ? Promise.reject(new Error(`${method} rejected`)) : Promise.resolve({}))
  return {
    isDestroyed: () => false,
    sendInputEvent: vi.fn(),
    debugger: { sendCommand },
  } as unknown as Electron.WebContents & { debugger: { sendCommand: typeof sendCommand } }
}

function operation(page: ReturnType<typeof contents>) {
  return new BrowserInputOperation(page, vi.fn().mockResolvedValue({}), () => {})
}

const releases = (page: ReturnType<typeof contents>, method: string) =>
  page.debugger.sendCommand.mock.calls.filter(([command, params]) =>
    command === method && (params.type === 'mouseReleased' || params.type === 'keyUp'))

describe('BrowserInputOperation', () => {
  it('releases a pressed button at its last drag position', async () => {
    const page = contents()
    const input = operation(page)
    await input.dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 })
    await input.dispatch('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 9, button: 'left' })

    await input.release()
    expect(releases(page, 'Input.dispatchMouseEvent')).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 8, y: 9, button: 'left' }],
    ])
  })

  it('does not release a button whose press the page rejected', async () => {
    const page = contents((method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')
    const input = operation(page)
    await expect(input.dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left' })).rejects.toThrow('rejected')

    await input.release()
    expect(releases(page, 'Input.dispatchMouseEvent')).toEqual([])
  })

  it('forgets a button once its own release succeeded', async () => {
    const page = contents()
    const input = operation(page)
    await input.dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left' })
    await input.dispatch('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 2, button: 'left' })
    page.debugger.sendCommand.mockClear()

    await input.release()
    expect(page.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('lifts a child-frame key that is still down and skips one whose key-down was rejected', async () => {
    const page = contents((method, params) => method === 'Input.dispatchKeyEvent' && params.code === 'KeyB')
    const input = operation(page)
    await input.dispatch('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }, 'child')
    await expect(input.dispatch('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB' }, 'child')).rejects.toThrow('rejected')
    expect(input.isKeyPressed('KeyA')).toBe(true)
    expect(input.isKeyPressed('KeyB')).toBe(false)

    await input.release()
    expect(releases(page, 'Input.dispatchKeyEvent')).toEqual([
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', text: undefined, commands: undefined }, 'child'],
    ])
  })
})
