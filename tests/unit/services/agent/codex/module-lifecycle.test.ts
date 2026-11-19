import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../../../../src/main/services/agent/codex/session-adapter', () => ({ CodexAppServerSession: { create: mock.create } }))
import { createCodexSdkModule } from '../../../../../src/main/services/agent/codex/module'

describe('Codex engine resource ownership', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('waits for cancelled creation cleanup before module close resolves', async () => {
    let release!: () => void
    let cancelled!: () => void
    const aborted = new Promise<void>(resolve => { cancelled = resolve })
    mock.create.mockImplementation(({ abortController }) => new Promise((_resolve, reject) => {
      abortController.signal.addEventListener('abort', () => {
        cancelled()
        release = () => reject(new Error('cancelled creation settled'))
      }, { once: true })
    }))
    const module = createCodexSdkModule()
    const creation = module.createSession({}).catch(error => error)
    let finished = false
    const closing = module.close().then(() => { finished = true })
    await aborted
    expect(finished).toBe(false)
    release()
    await closing
    expect(await creation).toBeInstanceOf(Error)
    expect(finished).toBe(true)
    await expect(module.createSession({})).rejects.toThrow('closing')
  })

  it('closes only its own live sessions and does not retain explicitly closed sessions', async () => {
    const firstClose = vi.fn(async () => {})
    const secondClose = vi.fn(async () => {})
    const otherClose = vi.fn(async () => {})
    mock.create.mockResolvedValueOnce({ close: firstClose }).mockResolvedValueOnce({ close: secondClose }).mockResolvedValueOnce({ close: otherClose })
    const module = createCodexSdkModule()
    const other = createCodexSdkModule()
    const first = await module.createSession({})
    await module.createSession({})
    await other.createSession({})
    await first.close()
    await module.close()
    expect(firstClose).toHaveBeenCalledOnce()
    expect(secondClose).toHaveBeenCalledOnce()
    expect(otherClose).not.toHaveBeenCalled()
    await other.close()
    expect(otherClose).toHaveBeenCalledOnce()
  })
})
