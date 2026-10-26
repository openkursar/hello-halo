import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ register: vi.fn(), send: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({
  app: { setAsDefaultProtocolClient: runtime.register, on: runtime.on },
}))
vi.mock('../../../src/main/foundation/product-config', () => ({ getDeepLinkScheme: () => 'halo-experimental' }))
vi.mock('../../../src/main/foundation/window.service', () => ({
  getMainWindow: () => null,
  sendToRenderer: runtime.send,
}))

import { consumePendingInviteLink, handleDeepLinkArgv, handleDeepLinkUrl, registerDeepLinkHandling } from '../../../src/main/services/deep-link.service'

beforeEach(() => {
  vi.clearAllMocks()
  consumePendingInviteLink()
})

describe('product protocol ownership', () => {
  it('registers only this product protocol', () => {
    registerDeepLinkHandling()
    expect(runtime.register.mock.calls[0][0]).toBe('halo-experimental')
  })

  it('does not consume stable-product links', () => {
    handleDeepLinkUrl('halo://join?office=office&invite=secret&server=https://office.example')
    expect(runtime.send).not.toHaveBeenCalled()
    expect(consumePendingInviteLink()).toBeNull()
  })

  it('accepts experimental invitations from command-line delivery', () => {
    handleDeepLinkArgv(['app', 'halo-experimental://join?office=office&invite=secret&server=https://office.example'])
    expect(consumePendingInviteLink()).toBe('https://office.example/?office=office&invite=secret')
    expect(consumePendingInviteLink()).toBeNull()
  })
})
