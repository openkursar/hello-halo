import { beforeEach, describe, expect, it, vi } from 'vitest'

const { unpackDhpkg, install, activate } = vi.hoisted(() => ({
  unpackDhpkg: vi.fn(),
  install: vi.fn(),
  activate: vi.fn(),
}))

vi.mock('../../../src/main/store', () => ({ unpackDhpkg }))
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: vi.fn(() => ({ install })) }))
vi.mock('../../../src/main/apps/manager/errors', () => ({ McpCommandBlockedError: class extends Error {} }))
vi.mock('../../../src/main/apps/runtime', () => ({ getAppRuntime: vi.fn(() => ({ activate })) }))
vi.mock('../../../src/main/services/security-policy', () => ({ MCP_COMMAND_BLOCKED_MESSAGE: 'blocked' }))
vi.mock('../../../src/main/services/analytics', () => ({ trackEvent: vi.fn() }))

const { importDhpkg } = await import('../../../src/main/controllers/store.controller')

describe('importDhpkg', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    install.mockResolvedValue('app-1')
    activate.mockResolvedValue(undefined)
  })

  it('binds a digital human to the named space', async () => {
    unpackDhpkg.mockResolvedValue({ spec: { type: 'automation' } })

    const res = await importDhpkg(Buffer.from('x'), 'space-7')

    expect(res).toEqual({ success: true, data: { appId: 'app-1' } })
    expect(install).toHaveBeenCalledWith('space-7', { type: 'automation' }, {})
    expect(activate).toHaveBeenCalledWith('app-1')
  })

  it('falls back to the Halo space when a digital human names no space', async () => {
    unpackDhpkg.mockResolvedValue({ spec: { type: 'automation' } })

    await importDhpkg(Buffer.from('x'), null)
    await importDhpkg(Buffer.from('x'), undefined)

    expect(install.mock.calls.map(call => call[0])).toEqual(['halo-temp', 'halo-temp'])
  })

  it('keeps skills and MCP servers global when no space is named', async () => {
    unpackDhpkg.mockResolvedValue({ spec: { type: 'skill' } })

    await importDhpkg(Buffer.from('x'), null)

    expect(install.mock.calls[0][0]).toBeNull()
  })

  it('still reports success when activation fails', async () => {
    unpackDhpkg.mockResolvedValue({ spec: { type: 'automation' } })
    activate.mockRejectedValue(new Error('boom'))

    const res = await importDhpkg(Buffer.from('x'), 'space-7')

    expect(res.success).toBe(true)
  })

  it('reports an install failure as an error result', async () => {
    unpackDhpkg.mockResolvedValue({ spec: { type: 'automation' } })
    install.mockRejectedValue(new Error('no such space'))

    const res = await importDhpkg(Buffer.from('x'), 'gone')

    expect(res).toEqual({ success: false, error: 'no such space' })
    expect(activate).not.toHaveBeenCalled()
  })
})
