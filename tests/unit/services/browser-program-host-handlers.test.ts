import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireAdapterPage, runBrowserCommand } from '../../../src/main/services/browser-program-host/browser'
import { runAdapterHelper } from '../../../src/main/services/browser-program-host/helpers'
import { fetchForAdapter } from '../../../src/main/services/browser-program-host/fetch'
import { pageContinuation, scopedPageUrl } from '../../../src/main/services/browser-program-host/page'
import { navigateForProgram } from '../../../src/main/services/browser-program-host/navigation'

const mocks = vi.hoisted(() => ({ states: new Map<string, any>(), fetch: vi.fn(), cookies: vi.fn(async () => []), navigate: vi.fn(async () => true), destroy: vi.fn(), allowed: true,
  // Each queued answer serves one request: { status, location?, headers?, body? }.
  answers: [] as Array<{ status: number; location?: string; headers?: Record<string, string>; body?: string }>,
  requests: [] as Array<{ method: string; url: string; useSessionCookies: boolean; headers: Record<string, string>; body: string }> }))
const navigationContents = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean; isLoadingMainFrame: () => boolean; stop: () => void }
navigationContents.isDestroyed = () => false
navigationContents.isLoadingMainFrame = () => false
navigationContents.stop = vi.fn()
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { app: new EventEmitter(), net: { request: (options: any) => {
    const request = Object.assign(new EventEmitter(), { headers: {} as Record<string, string>, chunks: [] as Buffer[],
      setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value },
      write(chunk: Buffer) { this.chunks.push(Buffer.from(chunk)) },
      abort: vi.fn(),
      end(this: EventEmitter & { headers: Record<string, string>; chunks: Buffer[] }) {
        mocks.requests.push({ method: options.method, url: options.url, useSessionCookies: options.useSessionCookies,
          headers: this.headers, body: Buffer.concat(this.chunks).toString('utf8') })
        const answer = mocks.answers.shift() ?? { status: 200, body: '{}' }
        queueMicrotask(() => {
          if (answer.location) { this.emit('redirect', answer.status, options.method, answer.location, answer.headers ?? {}); return }
          const response = Object.assign(new EventEmitter(), { statusCode: answer.status, headers: answer.headers ?? {} })
          this.emit('response', response)
          if (answer.body) response.emit('data', Buffer.from(answer.body))
          response.emit('end')
        })
      } })
    return request
  } } }
})
vi.mock('../../../src/main/foundation/config.service', () => ({ getHaloDir: () => globalThis.__HALO_TEST_DIR__ }))
vi.mock('../../../src/main/services/browser-policy.service', () => ({ isUrlAllowedByPolicy: (url: string) => mocks.allowed && !url.includes('blocked.') }))
vi.mock('../../../src/main/services/browser-view.service', () => ({ browserViewManager: {
  getState: (id: string) => mocks.states.get(id), navigate: mocks.navigate, destroy: mocks.destroy,
  getWebContents: () => navigationContents,
}, getBrowserSession: () => ({ fetch: mocks.fetch, cookies: { get: mocks.cookies } }) }))

function context() {
  let active: string | null = null
  const owned = new Set<string>()
  return {
    getActiveViewId: () => active, setActiveViewId: (id: string) => { active = id },
    canReachView: (id: string) => owned.has(id), visibleViewStates: () => [...owned].map(id => mocks.states.get(id)),
    openPage: vi.fn(async () => { active = `page-${mocks.states.size}`; owned.add(active); mocks.states.set(active, { id: active, url: 'https://example.com' }); return { viewId: active, fellBack: false } }),
    waitForNavigation: vi.fn(async () => {}), getPageInfo: vi.fn(async () => ({ url: 'https://example.com' })),
    evaluateScript: vi.fn(async () => 'fixture'),
    addVisiblePage: (id: string) => { owned.add(id); mocks.states.set(id, { id, url: 'https://example.com' }) },
  } as any
}
const signal = () => new AbortController().signal
beforeEach(() => { vi.clearAllMocks(); mocks.answers.length = 0; mocks.requests.length = 0; mocks.states.clear(); mocks.allowed = true; navigationContents.removeAllListeners(); navigationContents.isLoadingMainFrame = () => false })

describe('Browser program host handlers', () => {
  it('honors product policy for background requests and cookie access before reading the session', async () => {
    const grant = { name: 'example.com', commandId: 'read', hosts: ['example.com'], write: false, confirmed: false }
    mocks.allowed = false
    await expect(fetchForAdapter(grant, { url: 'https://example.com/' }, signal())).rejects.toMatchObject({ code: 'BROWSER_POLICY_BLOCKED' })
    await expect(runAdapterHelper(context(), grant, 'cookies_get', { domains: ['example.com'] }, signal()))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_BLOCKED' })
    expect(mocks.requests).toHaveLength(0)
    expect(mocks.cookies).not.toHaveBeenCalled()
  })

  it('saves a screenshot in the context download directory and returns only file metadata', async () => {
    const ctx = context()
    ctx.getDownloadDir = () => globalThis.__HALO_TEST_DIR__
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    ctx.captureScreenshot = vi.fn(async () => ({ data: jpeg.toString('base64'), mimeType: 'image/jpeg' }))
    await runBrowserCommand(ctx, 'open', { url: 'https://example.com/' }, signal())
    const result = await runBrowserCommand(ctx, 'screenshot', {}, signal()) as { filePath: string }
    expect(result).toEqual({ filePath: expect.stringMatching(/\.jpg$/), bytes: jpeg.length, mimeType: 'image/jpeg' })
    expect(readFileSync(result.filePath)).toEqual(jpeg)
  })
  it('rejects a policy-blocked initial URL without allocating a blank page', async () => {
    const ctx = context()
    mocks.allowed = false
    await expect(runBrowserCommand(ctx, 'open', { url: 'https://example.com' }, signal())).rejects.toMatchObject({ code: 'BROWSER_POLICY_BLOCKED' })
    expect(ctx.openPage).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
  it('keeps invocation-local failure evidence even if shared browser state clears it', async () => {
    const ctx = context()
    const { viewId } = await ctx.openPage('about:blank', 'pc')
    mocks.navigate.mockImplementationOnce(async () => {
      navigationContents.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://example.com/?token=fixture', true)
      mocks.states.get(viewId).error = undefined
      return true
    })
    await expect(navigateForProgram(viewId, 'https://example.com', signal()))
      .rejects.toMatchObject({ code: 'HOST_NAVIGATION_FAILED', message: 'Navigation failed: ERR_CERT_AUTHORITY_INVALID.' })
    expect(navigationContents.eventNames()).toEqual([])
  })

  it('cancels only the invocation navigation and releases its listeners', async () => {
    const ctx = context()
    const { viewId } = await ctx.openPage('about:blank', 'pc')
    const controller = new AbortController()
    navigationContents.isLoadingMainFrame = () => true
    const pending = navigateForProgram(viewId, 'https://example.com', controller.signal)
    const rejected = expect(pending).rejects.toThrow('fixture cancel')
    await vi.waitFor(() => expect(navigationContents.listenerCount('did-stop-loading')).toBe(1))
    controller.abort(new Error('fixture cancel'))
    await rejected
    expect(navigationContents.stop).toHaveBeenCalledOnce()
    expect(navigationContents.eventNames()).toEqual([])
  })

  it('awaits the requested navigation independently of initial blank-page loading state', async () => {
    const ctx = context()
    let complete!: (value: boolean) => void
    mocks.navigate.mockImplementationOnce(() => new Promise<boolean>(resolve => { complete = resolve }))
    const operation = runBrowserCommand(ctx, 'open', { url: 'https://example.com' }, signal())
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(ctx.getActiveViewId(), 'https://example.com/'))
    expect(ctx.openPage).toHaveBeenCalledWith('about:blank', 'pc')
    expect(ctx.getPageInfo).not.toHaveBeenCalled()
    complete(true)
    await operation
    expect(ctx.getPageInfo).toHaveBeenCalledOnce()
  })

  it('reports certificate reasons on initial and reused pages without leaking URL queries', async () => {
    const ctx = context()
    ctx.waitForNavigation.mockImplementation(async () => {
      mocks.states.get(ctx.getActiveViewId()).error = 'ERR_CERT_COMMON_NAME_INVALID (-200) loading https://example.com/?token=private-fixture'
    })
    await expect(runBrowserCommand(ctx, 'open', { url: 'https://example.com' }, signal()))
      .rejects.toMatchObject({ code: 'HOST_NAVIGATION_FAILED', message: 'Navigation failed: ERR_CERT_COMMON_NAME_INVALID.' })
    mocks.navigate.mockResolvedValueOnce(false)
    await expect(runBrowserCommand(ctx, 'open', { url: 'https://example.com' }, signal()))
      .rejects.toMatchObject({ code: 'HOST_NAVIGATION_FAILED', message: 'Navigation failed: ERR_CERT_COMMON_NAME_INVALID.' })
  })
  it('does not report a still-loading page as successful navigation', async () => {
    const ctx = context()
    ctx.waitForNavigation.mockImplementation(async () => { mocks.states.get(ctx.getActiveViewId()).isLoading = true })
    await expect(runBrowserCommand(ctx, 'open', { url: 'https://example.com' }, signal()))
      .rejects.toMatchObject({ code: 'HOST_NAVIGATION_TIMEOUT' })
  })
  it('requires a confirmed write and absolute files, and checks cancellation before setting files', async () => {
    const file = join(globalThis.__HALO_TEST_DIR__, 'upload.txt')
    writeFileSync(file, 'fixture')
    const ctx = context()
    await acquireAdapterPage(ctx, 'example.com')
    const contents = { getURL: () => 'https://example.com', isDestroyed: () => false }
    ctx.getWebContents = () => contents
    const controller = new AbortController()
    ctx.sendCDPCommand = vi.fn(async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.describeNode') {
        controller.abort(new Error('cancelled fixture'))
        return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } }
      }
      throw new Error('Unexpected upload')
    })
    const grant = { name: 'example.com', commandId: 'upload', hosts: ['example.com'], pageHosts: ['example.com'], write: true, confirmed: true }
    const payload = { selector: '#upload', files: [file] }
    await expect(runAdapterHelper(ctx, { ...grant, confirmed: false }, 'set_file_input', payload, signal())).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    await expect(runAdapterHelper(ctx, grant, 'set_file_input', { ...payload, files: ['relative.txt'] }, signal())).rejects.toMatchObject({ code: 'HOST_FILE_DENIED' })
    expect(ctx.sendCDPCommand).not.toHaveBeenCalled()
    await expect(runAdapterHelper(ctx, grant, 'set_file_input', payload, controller.signal)).rejects.toThrow('cancelled fixture')
    expect(ctx.sendCDPCommand.mock.calls.map((call: unknown[]) => call[0])).not.toContain('DOM.setFileInputFiles')
  })
  it('reuses owned sessions and refuses cross-context and user-bound navigation', async () => {
    const first = context(), second = context()
    await runBrowserCommand(first, 'open', { session: 'work', url: 'https://example.com' }, signal())
    await runBrowserCommand(first, 'open', { session: 'work', url: 'https://example.com/next' }, signal())
    expect(first.openPage).toHaveBeenCalledTimes(1)
    expect(mocks.navigate.mock.calls).toEqual([
      [first.getActiveViewId(), 'https://example.com/'],
      [first.getActiveViewId(), 'https://example.com/next'],
    ])
    await expect(runBrowserCommand(second, 'bind', { tabId: first.getActiveViewId() }, signal())).rejects.toMatchObject({ code: 'HOST_PAGE_UNAVAILABLE' })
    first.addVisiblePage('user-page')
    await runBrowserCommand(first, 'bind', { session: 'user', tabId: 'user-page' }, signal())
    await expect(runBrowserCommand(first, 'open', { session: 'user', url: 'https://example.com' }, signal())).rejects.toMatchObject({ code: 'HOST_PAGE_NOT_OWNED' })
    await runBrowserCommand(first, 'close', { session: 'user' }, signal())
    expect(mocks.destroy).not.toHaveBeenCalled()
    await runBrowserCommand(first, 'close', { session: 'work' }, signal())
    expect(mocks.destroy).toHaveBeenCalledWith('page-0')
  })
  it('rejects unsupported targeting and dangerous navigation schemes', async () => {
    await expect(runBrowserCommand(context(), 'click', { selector: '#button' }, signal())).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await expect(runBrowserCommand(context(), 'open', { url: 'file:///tmp/example' }, signal())).rejects.toMatchObject({ code: 'INVALID_URL' })
    await expect(runBrowserCommand(context(), 'upload', {}, signal())).rejects.toMatchObject({ code: 'HOST_UNSUPPORTED_COMMAND' })
  })
  it('sends the request as the program wrote it through the browser session and drops response credentials', async () => {
    const grant = { name: 'example.com', commandId: 'groups', hosts: ['example.com'], write: false, confirmed: false }
    mocks.answers.push({ status: 200, headers: { 'set-cookie': 'fixture-placeholder=1', 'content-type': 'application/json' }, body: '{"fixture":true}' })
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example',
      'X-Requested-With': 'XMLHttpRequest', Host: 'ignored.example', 'Content-Length': '1' }, body: '{"type":0}' }
    const result: any = await fetchForAdapter(grant, { url: 'https://api.other.example/query', options }, signal())
    expect(result).toMatchObject({ ok: true, status: 200, url: 'https://api.other.example/query', redirected: false, body: '{"fixture":true}' })
    expect(result.headers).not.toHaveProperty('set-cookie')
    expect(mocks.requests[0]).toMatchObject({ method: 'POST', url: 'https://api.other.example/query', useSessionCookies: true, body: '{"type":0}' })
    expect(mocks.requests[0].headers).toMatchObject({ 'content-type': 'application/json', origin: 'https://other.example', 'x-requested-with': 'XMLHttpRequest' })
    expect(mocks.requests[0].headers).not.toHaveProperty('host')
    expect(mocks.requests[0].headers).not.toHaveProperty('content-length')
  })
  it('follows redirects like a browser and reports where the request ended', async () => {
    const grant = { name: 'example.com', commandId: 'read', hosts: ['example.com'], write: false, confirmed: false }
    mocks.answers.push({ status: 302, location: 'http://sso.example.org/login?service=x' }, { status: 200, body: '<html>sign in</html>' })
    expect(await fetchForAdapter(grant, { url: 'http://example.com/api', options: { method: 'POST', body: '{}' } }, signal()))
      .toMatchObject({ ok: true, status: 200, url: 'http://sso.example.org/login?service=x', redirected: true, body: '<html>sign in</html>' })
    expect(mocks.requests.map(request => request.method)).toEqual(['POST', 'GET'])
    expect(mocks.requests[1].body).toBe('')
    mocks.answers.push(...Array.from({ length: 11 }, () => ({ status: 307, location: 'http://example.com/loop' })))
    await expect(fetchForAdapter(grant, { url: 'http://example.com/loop' }, signal())).rejects.toMatchObject({ code: 'HOST_TOO_MANY_REDIRECTS' })
    mocks.answers.length = 0
    mocks.answers.push({ status: 302, location: 'http://blocked.example.net/' })
    await expect(fetchForAdapter(grant, { url: 'http://example.com/' }, signal())).rejects.toMatchObject({ code: 'BROWSER_POLICY_BLOCKED' })
  })
  it('keeps write confirmation and read-only methods', async () => {
    const grant = { name: 'example.com', commandId: 'query', hosts: ['example.com'], write: false, confirmed: false }
    await fetchForAdapter(grant, { url: 'https://example.com/query', options: { method: 'POST', body: '{}' } }, signal())
    await expect(fetchForAdapter({ ...grant, write: true }, { url: 'https://example.com/write', options: { method: 'POST' } }, signal())).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    await expect(fetchForAdapter(grant, { url: 'https://example.com/', method: 'DELETE' }, signal())).rejects.toMatchObject({ code: 'HOST_UNSUPPORTED_METHOD' })
    expect(mocks.requests).toHaveLength(1)
  })
  it('lets the browser supply its cookies and adds cookies the program names that it does not hold', async () => {
    const grant = { name: 'example.com', commandId: 'query', hosts: ['example.com'], write: false, confirmed: false }
    mocks.cookies.mockResolvedValue([{ name: 'SESSION', value: 'browser' }] as any)
    await fetchForAdapter(grant, { url: 'https://example.com/a', headers: { Cookie: '' } }, signal())
    await fetchForAdapter(grant, { url: 'https://example.com/b', headers: { Cookie: 'SESSION=browser' } }, signal())
    await fetchForAdapter(grant, { url: 'https://example.com/c', headers: { Cookie: 'token=program' } }, signal())
    expect(mocks.requests.map(request => [request.useSessionCookies, request.headers.cookie])).toEqual([
      [true, undefined], [true, undefined], [false, 'SESSION=browser; token=program'],
    ])
  })
  it('lets a page go anywhere the browser policy allows, runs Adapters only on their sites and never resumes writes', () => {
    const grant = { name: 'example.com', commandId: 'read', hosts: ['example.com', 'login.example.org'], pageHosts: ['example.com'], write: false, confirmed: true }
    const navigation = (url: string, resume: boolean) => ({ __webcli_navigation: { version: 1, url, resume } })
    expect(pageContinuation(navigation('https://example.com/path', true), grant)?.resume).toBe(true)
    expect(pageContinuation(navigation('https://login.example.org', false), grant)?.resume).toBe(false)
    expect(pageContinuation(navigation('https://login.example.org', true), grant)?.resume).toBe(true)
    expect(() => scopedPageUrl('http://sso.example.org:8080/cas/login', ['example.com'])).toThrow(/sso\.example\.org:8080/)
    expect(() => pageContinuation(navigation('https://example.com', true), { ...grant, write: true })).toThrow(/replayed/)
    for (const url of ['https://example.com.evil.example.org', 'file:///tmp/fixture', 'https://user:placeholder@example.com']) {
      expect(() => scopedPageUrl(url, ['*.example.com'])).toThrow()
    }
    for (const key of ['__webcli_page_query', '__cdp_action', '__after']) expect(() => pageContinuation({ [key]: {} }, grant)).toThrow(/not supported/)
    expect(() => pageContinuation({ __webcli_navigation: { url: 'https://example.com' } }, grant)).toThrow(/Invalid/)
  })
})
