import { stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserContext } from '../ai-browser'
import { browserViewManager, getBrowserSession } from '../browser-view.service'
import { withBrowserFrames } from '../browser-host'
import { acquireAdapterPage } from './browser'
import { pageUrl, scopedPageUrl } from './page'
import { fetchForAdapter, type HostGrant } from './fetch'
import { fail, MAX_BYTES } from './protocol'
import { sessionStorageValue } from './storage-cache'
import { navigateForProgram } from './navigation'

export async function cookiesForAdapter(grant: HostGrant, payload: Record<string, any>): Promise<{ cookies: Electron.Cookie[] }> {
  const browser = getBrowserSession()
  const domains = payload.domains ?? (payload.domain ? [payload.domain] : [])
  if (!Array.isArray(domains) || domains.length > 32) return fail('INVALID_ARGS', 'Invalid cookie domains.')
  const values: Electron.Cookie[] = []
  if (domains.length) {
    for (const value of domains) {
      if (typeof value !== 'string' || !/^\.?[a-z0-9.-]+$/i.test(value)) return fail('INVALID_ARGS', 'Invalid cookie domain.')
      const domain = value.replace(/^\./, '').toLowerCase()
      pageUrl(`https://${domain}/`)
      values.push(...await browser.cookies.get({ domain }))
    }
  } else {
    const url = pageUrl(payload.url || grant.initialUrl || '')
    values.push(...await browser.cookies.get({ url }))
  }
  if (payload.names !== undefined && (!Array.isArray(payload.names) || payload.names.length > 32 || payload.names.some((name: unknown) => typeof name !== 'string'))) return fail('INVALID_ARGS', 'Invalid cookie names.')
  const seen = new Set<string>()
  return { cookies: values.filter(cookie => {
    const key = `${cookie.name}\0${cookie.domain}\0${cookie.path}`
    if (seen.has(key) || (payload.names && !payload.names.includes(cookie.name))) return false
    seen.add(key)
    return true
  }) }
}

export async function runAdapterHelper(ctx: BrowserContext, grant: HostGrant, action: string, payload: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  if (action === 'cookies_get') return cookiesForAdapter(grant, payload)
  if (action === 'backend_fetch') return fetchForAdapter(grant, payload, signal)
  if (action === 'set_file_input') {
    if (!grant.write || !grant.confirmed) return fail('CONFIRMATION_REQUIRED', 'File upload requires an explicitly confirmed write command.')
    if (typeof payload.selector !== 'string' || !payload.selector || payload.selector.length > 4096
      || !Array.isArray(payload.files) || !payload.files.length || payload.files.length > 32) return fail('INVALID_ARGS', 'Invalid file upload request.')
    // The program, not the host, knows its command's arguments; it vouches for these paths.
    for (const file of payload.files) {
      if (typeof file !== 'string' || !isAbsolute(file)) return fail('HOST_FILE_DENIED', 'Upload files must be absolute paths.')
      const info = await stat(file)
      if (!info.isFile()) return fail('HOST_FILE_DENIED', 'Upload path must identify a file.')
    }
    const viewId = ctx.getActiveViewId()
    const contents = ctx.getWebContents()
    if (!viewId || !contents || !ctx.canReachView(viewId) || !grant.pageHosts) return fail('HOST_PAGE_UNAVAILABLE', 'Upload requires the active Adapter page.')
    if (await acquireAdapterPage(ctx, grant.name) !== viewId) return fail('HOST_PAGE_CHANGED', 'Upload requires the command-owned Adapter page.')
    scopedPageUrl(contents.getURL(), grant.pageHosts)
    const assertActive = () => {
      signal.throwIfAborted()
      if (contents.isDestroyed() || ctx.getActiveViewId() !== viewId || ctx.getWebContents() !== contents || !ctx.canReachView(viewId)) return fail('HOST_PAGE_CHANGED', 'Upload page changed; it was not retried.')
      scopedPageUrl(contents.getURL(), grant.pageHosts!)
    }
    const document = await ctx.sendCDPCommand<{ root: { nodeId: number } }>('DOM.getDocument')
    assertActive()
    const node = await ctx.sendCDPCommand<{ nodeId: number }>('DOM.querySelector', { nodeId: document.root.nodeId, selector: payload.selector })
    assertActive()
    if (!node.nodeId) return fail('HOST_FILE_INPUT_UNAVAILABLE', 'File input was not found.')
    const description = await ctx.sendCDPCommand<{ node: { nodeName: string; attributes?: string[] } }>('DOM.describeNode', { nodeId: node.nodeId })
    assertActive()
    const attributes = description.node.attributes || []
    const typeIndex = attributes.indexOf('type')
    if (description.node.nodeName !== 'INPUT' || typeIndex < 0 || attributes[typeIndex + 1]?.toLowerCase() !== 'file') return fail('HOST_FILE_INPUT_UNAVAILABLE', 'Upload target must be a file input.')
    await ctx.sendCDPCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files: payload.files })
    assertActive()
    return { success: true, files: payload.files }
  }
  if (action === 'download') {
    const response = await fetchForAdapter(grant, { url: payload.url, options: { responseEncoding: 'base64' } }, signal) as any
    if (!response.ok) return fail('HOST_DOWNLOAD_FAILED', 'Download failed; redirects are not followed.')
    const name = basename(String(payload.filename || 'download.bin')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)
    const filename = join(ctx.getDownloadDir(), `${randomUUID()}-${name}`)
    await writeFile(filename, Buffer.from(response.body, 'base64'), { flag: 'wx', mode: 0o600, signal })
    return { downloadId: randomUUID(), filename, path: filename, status: 'completed', size: response.size }
  }
  if (!['storage_get', 'main_world_eval', 'browser_fetch'].includes(action)) return fail('HOST_UNSUPPORTED_HELPER', `Host helper is unsupported: ${action}`)
  if (action === 'storage_get' && payload.area === 'session') {
    if (!grant.pageHosts || !grant.initialUrl) return fail('HOST_PAGE_UNAVAILABLE', 'The Adapter did not declare a page origin.')
    if (typeof payload.key !== 'string' || !payload.key || payload.key.length > 1024) return fail('INVALID_ARGS', 'Storage requires a bounded key.')
    for (const option of ['forceRefresh', 'cacheOnly']) {
      if (payload[option] !== undefined && typeof payload[option] !== 'boolean') return fail('INVALID_ARGS', 'Storage cache options must be booleans.')
    }
    const url = pageUrl(payload.origin || payload.storageScope || payload.url || grant.initialUrl)
    const origin = new URL(url).origin
    return sessionStorageValue({ adapter: grant.name, origin, key: payload.key }, payload, signal, async () => {
      const visible = ctx.visibleViewStates().filter(page => {
        try { return new URL(page.url).origin === origin } catch { return false }
      }).sort((a, b) => Number(b.id === ctx.getActiveViewId()) - Number(a.id === ctx.getActiveViewId()))
      if (visible.length) {
        const viewId = visible[0].id
        const contents = browserViewManager.getWebContents(viewId)
        if (!contents || !ctx.canReachView(viewId)) return fail('HOST_PAGE_UNAVAILABLE', 'Storage login page is unavailable.')
        return withBrowserFrames(contents, async () => {
          const assertOrigin = () => {
            signal.throwIfAborted()
            if (contents.isDestroyed() || !ctx.canReachView(viewId) || new URL(contents.getURL()).origin !== origin) return fail('HOST_PAGE_CHANGED', 'Storage login page changed.')
          }
          assertOrigin()
          const value = await contents.executeJavaScript(`sessionStorage.getItem(${JSON.stringify(payload.key)})`)
          assertOrigin()
          return { value: value ?? null }
        }, 5000, { signal, deadline: Date.now() + 10000 })
      }
      return await runPageHelper(ctx, grant, action, payload, signal) as { value: string | null }
    })
  }
  return runPageHelper(ctx, grant, action, payload, signal)
}

async function runPageHelper(ctx: BrowserContext, grant: HostGrant, action: string, payload: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  if (!grant.pageHosts || !grant.initialUrl) return fail('HOST_PAGE_UNAVAILABLE', 'The Adapter did not declare a page origin.')
  const initial = pageUrl(grant.initialUrl)
  const viewId = await acquireAdapterPage(ctx, grant.name)
  const contents = ctx.getWebContents()
  if (!contents) return fail('HOST_PAGE_UNAVAILABLE', 'Adapter page is unavailable.')
  const blank = () => !contents.getURL() || /^about:blank(?:#|$)/.test(contents.getURL())
  let temporaryStoragePage = false
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const assertActive = () => {
    controller.signal.throwIfAborted()
    if (contents.isDestroyed() || !ctx.canReachView(viewId) || ctx.getWebContents() !== contents) return fail('HOST_PAGE_CHANGED', 'Adapter helper page changed.')
  }
  let storageInterceptor: ((event: Electron.Event, method: string, params: any) => void) | undefined
  let completed = false
  try {
    return await withBrowserFrames(contents, async () => {
      temporaryStoragePage = action === 'storage_get' && payload.area !== 'session' && blank()
      if (action === 'storage_get') {
        if (typeof payload.key !== 'string' || !payload.key || payload.key.length > 1024) return fail('INVALID_ARGS', 'Storage requires a bounded key.')
        if (payload.area !== undefined && !['local', 'session'].includes(payload.area)) return fail('INVALID_ARGS', 'Invalid storage area.')
        const storageUrl = pageUrl(payload.origin || payload.storageScope || payload.url || initial)
        const origin = new URL(storageUrl).origin
        if (temporaryStoragePage) {
          // CDP requires an origin-bearing frame. Fulfill locally so reading persisted
          // localStorage cannot run site scripts or issue a business-page request.
          storageInterceptor = (_event: Electron.Event, method: string, params: any) => {
            if (method !== 'Fetch.requestPaused') return
            const operation = params.request.url === `${origin}/`
              ? ctx.sendCDPCommand('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<!doctype html><title>Storage</title>').toString('base64') })
              : ctx.sendCDPCommand('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' })
            operation.catch(error => controller.abort(error))
          }
          contents.debugger.on('message', storageInterceptor)
          await ctx.sendCDPCommand('Network.setBypassServiceWorker', { bypass: true })
          await ctx.sendCDPCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
          await navigateForProgram(viewId, `${origin}/`, controller.signal)
        }
        if (payload.area === 'session' && blank()) {
          if (payload.cacheOnly === true) return fail('PAGE_CONTEXT_REQUIRED', 'Session storage requires an Adapter page.')
          await navigateForProgram(viewId, storageUrl, controller.signal)
        }
        assertActive()
        if (new URL(contents.getURL()).origin !== origin) return fail('PAGE_CONTEXT_REQUIRED', 'Storage requires a page in the requested origin.')
        const result = await ctx.sendCDPCommand<{ result: { value?: string | null }; exceptionDetails?: unknown }>('Runtime.evaluate', {
          expression: `window.${payload.area === 'session' ? 'sessionStorage' : 'localStorage'}.getItem(${JSON.stringify(payload.key)})`, returnByValue: true,
        })
        assertActive()
        if (result.exceptionDetails) return fail('HOST_STORAGE_FAILED', 'Storage is unavailable in this page.')
        if (Buffer.byteLength(result.result.value || '') > 64000) return fail('HOST_PAYLOAD_TOO_LARGE', 'Storage value exceeds the size limit.')
        completed = true
        return { value: result.result.value ?? null }
      }
      let expression = payload.expression
      if (action === 'browser_fetch') {
        const url = pageUrl(payload.url)
        const options = payload.options || payload
        const method = String(options.method || 'GET').toUpperCase()
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return fail('HOST_UNSUPPORTED_METHOD', 'HTTP method is not supported.')
        if (grant.write && !grant.confirmed) return fail('CONFIRMATION_REQUIRED', 'Write commands require explicit confirmation.')
        if (!grant.write && !['GET', 'HEAD', 'POST'].includes(method)) return fail('HOST_UNSUPPORTED_METHOD', 'Read commands cannot use a mutating HTTP method.')
        if (options.body !== undefined && typeof options.body !== 'string') return fail('INVALID_ARGS', 'Request body must be text.')
        const headers = Object.fromEntries([...new Headers(options.headers || {})].filter(([name]) => !/^(cookie2?|host|content-length|origin|referer|connection|transfer-encoding|proxy-authorization)$/i.test(name) && !/^sec-/i.test(name)))
        expression = `(${pageFetch.toString()})(${JSON.stringify({ url, method, headers, body: options.body, limit: MAX_BYTES / 2 })})`
      } else if (typeof expression !== 'string' || expression.length > 100000) return fail('INVALID_ARGS', 'Main-world evaluation requires a bounded expression.')
      if (blank()) {
        await navigateForProgram(viewId, initial, controller.signal)
      }
      assertActive()
      scopedPageUrl(contents.getURL(), grant.pageHosts!)
      const value = await ctx.sendCDPCommand<{ result: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      }, 30000)
      assertActive()
      scopedPageUrl(contents.getURL(), grant.pageHosts!)
      if (value.exceptionDetails) return fail('ADAPTER_EXECUTION_FAILED', 'Main-world helper failed; it was not retried.')
      if (Buffer.byteLength(JSON.stringify(value.result.value) || '') > MAX_BYTES / 2) return fail('HOST_PAYLOAD_TOO_LARGE', 'Helper result exceeds the size limit.')
      completed = true
      if (action === 'browser_fetch') return value.result.value
      return { value: value.result.value ?? null }
    }, 5000, { signal: controller.signal, deadline: Date.now() + 35000 })
  } finally {
    signal.removeEventListener('abort', abort)
    controller.abort()
    if (storageInterceptor && !contents.isDestroyed()) contents.debugger.removeListener('message', storageInterceptor)
    if (!completed || temporaryStoragePage) browserViewManager.destroy(viewId)
  }
}

// Serialized into the Adapter's page to preserve browser origin and CORS semantics.
async function pageFetch(input: { url: string; method: string; headers: Record<string, string>; body?: string; limit: number }) {
  const response = await fetch(input.url, { method: input.method, headers: input.headers,
    ...(!['GET', 'HEAD'].includes(input.method) ? { body: input.body } : {}), credentials: 'include', redirect: 'manual' })
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (reader) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > input.limit) throw new Error('Browser response exceeds the size limit.')
      chunks.push(chunk.value)
    }
  } finally { await reader?.cancel() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return { status: response.status, ok: response.ok, url: response.url || input.url, redirected: response.redirected,
    headers: Object.fromEntries(response.headers), body: new TextDecoder().decode(bytes), replay: { transport: 'browser-page' } }
}
