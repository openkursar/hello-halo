import { beforeEach, describe, expect, it, vi } from 'vitest'

const serverMode = vi.hoisted(() => ({ on: false }))

vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}))
vi.mock('../../../../src/main/foundation/runtime-mode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isServerMode: () => serverMode.on,
}))

const { buildInputTools } = await import('../../../../src/main/services/ai-browser/tools/input')
const { buildAllTools } = await import('../../../../src/main/services/ai-browser/tools')
const { registerBrowserRoutes } = await import('../../../../src/main/http/routes/browser.routes')

type Ctx = Parameters<typeof buildAllTools>[0]
type Tool = { name: string; handler: (args: unknown, extra: unknown) => Promise<{ content?: unknown[] }> }

function context(notice: string | null): Ctx {
  return {
    takeUserInputNotice: vi.fn(() => notice),
    getActiveViewId: () => null,
    beginToolCall: vi.fn(),
    endToolCall: vi.fn(),
  } as unknown as Ctx
}

function names(tools: unknown[]): string[] {
  return (tools as Tool[]).map(t => t.name)
}

beforeEach(() => {
  serverMode.on = false
})

describe('browser_fill_secret', () => {
  it('is not offered on a desktop', () => {
    expect(names(buildInputTools(context(null)))).not.toContain('browser_fill_secret')
  })

  it('is offered on a server', () => {
    serverMode.on = true
    expect(names(buildInputTools(context(null)))).toContain('browser_fill_secret')
  })
})

describe('the user-input notice', () => {
  /** Any tool will do; with no active page browser_fill returns at once. */
  async function callATool(): Promise<{ content?: unknown[] }> {
    const tools = buildAllTools(context('The user clicked on this page.')) as unknown as Tool[]
    return tools.find(t => t.name === 'browser_fill')!.handler({ uid: 'x', value: 'y' }, {})
  }

  it.each([false, true])('blocks stale actions after remote input (server mode: %s)', async (on) => {
    serverMode.on = on
    const result = await callATool()
    expect(JSON.stringify(result.content)).toContain('The user clicked on this page.')
  })
})

describe('/api/browser', () => {
  function gate(): (req: unknown, res: { json: (body: unknown) => void }, next: () => void) => void {
    const use = vi.fn()
    registerBrowserRoutes({ use, get: vi.fn(), post: vi.fn() } as never)
    expect(use).toHaveBeenCalledWith('/api/browser', expect.any(Function))
    return use.mock.calls[0][1]
  }

  it('declines on a desktop', () => {
    const json = vi.fn()
    const next = vi.fn()
    gate()({}, { json }, next)
    expect(next).not.toHaveBeenCalled()
    expect(json).toHaveBeenCalledWith({ success: false, error: 'The browser live view is only available on a Halo server' })
  })

  it('passes through on a server', () => {
    serverMode.on = true
    const json = vi.fn()
    const next = vi.fn()
    gate()({}, { json }, next)
    expect(next).toHaveBeenCalled()
    expect(json).not.toHaveBeenCalled()
  })
})
