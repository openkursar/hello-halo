import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import type { BrowserContext } from '../ai-browser'
import { browserViewManager } from '../browser-view.service'
import { isUrlAllowedByPolicy } from '../browser-policy.service'
import { withBrowserFrames } from '../browser-host'
import { acquireAdapterPage } from './browser'
import type { HostGrant } from './fetch'
import { fail, MAX_BYTES } from './protocol'
import { navigateForWebCli } from './navigation'

const invocationSchema = z.object({ initialUrl: z.string().url(), script: z.string().min(1).max(MAX_BYTES / 2) })
const navigationSchema = z.object({ version: z.literal(1), url: z.string().url(), resume: z.boolean(), result: z.unknown().optional() }).strict()

export function scopedPageUrl(value: string, patterns: string[]): string {
  let url: URL
  try { url = new URL(value) } catch { return fail('INVALID_URL', 'Adapter navigation requires an absolute HTTP(S) URL.') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !patterns.some(pattern => pattern.startsWith('*.')
    ? host === pattern.slice(2) || host.endsWith(`.${pattern.slice(2)}`) : host === pattern)) {
    return fail('HOST_SCOPE_DENIED', 'Adapter navigation is outside its declared host scope.')
  }
  if (!isUrlAllowedByPolicy(url.href)) return fail('BROWSER_POLICY_BLOCKED', 'URL blocked by browser policy.')
  return url.href
}

export function pageContinuation(result: any, grant: HostGrant): z.infer<typeof navigationSchema> | null {
  if (!result || typeof result !== 'object') return null
  if (['__webcli_page_query', '__cdp_action', '__after'].some(key => Object.hasOwn(result, key))) {
    return fail('HOST_UNSUPPORTED_CONTINUATION', 'This Adapter continuation is not supported by the page host.')
  }
  if (!Object.hasOwn(result, '__webcli_navigation')) return null
  const parsed = navigationSchema.safeParse(result.__webcli_navigation)
  if (!parsed.success) return fail('HOST_INVALID_CONTINUATION', 'Invalid Adapter navigation continuation.')
  if (parsed.data.resume && grant.write) return fail('HOST_WRITE_REPLAY_DENIED', 'Write commands cannot be replayed after navigation.')
  scopedPageUrl(parsed.data.url, parsed.data.resume ? grant.pageHosts! : grant.hosts)
  return parsed.data
}

export async function runPageAdapter(ctx: BrowserContext, grant: HostGrant, payload: unknown, signal: AbortSignal,
  helper?: (action: string, payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  const parsed = invocationSchema.safeParse(payload)
  if (!parsed.success || !grant.pageHosts) return fail('HOST_INVALID_PAGE_REQUEST', 'Invalid page Adapter invocation.')
  const { script, initialUrl } = parsed.data
  scopedPageUrl(initialUrl, grant.pageHosts)
  signal.throwIfAborted()
  const viewId = await acquireAdapterPage(ctx, grant.name)
  const contents = ctx.getWebContents()
  if (!contents) return fail('HOST_PAGE_UNAVAILABLE', 'Adapter page is unavailable.')
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let navigationHosts = grant.pageHosts
  let executionPending = false
  let invoking = false
  let lastNavigation = Date.now()
  let completed = false
  const guard = (event: Electron.Event, url: string) => {
    try { scopedPageUrl(url, navigationHosts) } catch (error) {
      event.preventDefault()
      controller.abort(error)
    }
  }
  const guardRedirect = (event: Electron.Event, url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) guard(event, url)
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guardRedirect)
  const documentChanged = (_event: Electron.Event, _url: string, inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !inPlace) lastNavigation = Date.now()
    if (invoking && isMainFrame && !inPlace) controller.abort(Object.assign(new Error('Adapter document changed during execution; it was not retried.'), { code: 'HOST_DOCUMENT_CHANGED' }))
  }
  contents.on('did-start-navigation', documentChanged)
  const assertPage = () => {
    controller.signal.throwIfAborted()
    if (!ctx.canReachView(viewId) || ctx.getActiveViewId() !== viewId || ctx.getWebContents() !== contents) return fail('HOST_PAGE_CHANGED', 'Adapter page ownership changed during execution.')
    scopedPageUrl(contents.getURL(), navigationHosts)
  }
  const waitUntilReady = async () => {
    const deadline = Date.now() + 10000
    let stableSince = Date.now()
    while (true) {
      controller.signal.throwIfAborted()
      if (contents.isDestroyed()) return fail('HOST_PAGE_UNAVAILABLE', 'Adapter page closed before execution.')
      if (contents.isLoadingMainFrame()) stableSince = Date.now()
      else if (Date.now() - Math.max(stableSince, lastNavigation) >= 300) { assertPage(); return }
      if (Date.now() >= deadline) return fail('HOST_PAGE_NOT_READY', 'Adapter page kept navigating; no command was invoked.')
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
  }
  const navigate = async (url: string) => {
    controller.signal.throwIfAborted()
    scopedPageUrl(url, navigationHosts)
    executionPending = true
    await navigateForWebCli(viewId, url, controller.signal)
    await waitUntilReady()
    assertPage()
    executionPending = false
  }
  try {
    return await withBrowserFrames(contents, async () => {
      if (!contents.getURL() || /^about:blank(?:#|$)/.test(contents.getURL())) await navigate(initialUrl)
      else await waitUntilReady()
      for (let hops = 0; ; hops++) {
        assertPage()
        const frame = await ctx.sendCDPCommand<{ frameTree: { frame: { id: string; loaderId: string } } }>('Page.getFrameTree')
        const world = await ctx.sendCDPCommand<{ executionContextId: number }>('Page.createIsolatedWorld', {
          frameId: frame.frameTree.frame.id, worldName: 'halo-webcli-adapter', grantUniveralAccess: false,
        })
        assertPage()
        const current = await ctx.sendCDPCommand<typeof frame>('Page.getFrameTree')
        if (current.frameTree.frame.loaderId !== frame.frameTree.frame.loaderId) return fail('HOST_DOCUMENT_CHANGED', 'Adapter document changed before execution; it was not retried.')
        executionPending = true
        invoking = true
        const binding = `webcli_${randomBytes(16).toString('hex')}`
        let queue = Promise.resolve()
        const onBinding = (_event: Electron.Event, method: string, params: any) => {
          if (method !== 'Runtime.bindingCalled' || params.name !== binding || params.executionContextId !== world.executionContextId) return
          queue = queue.then(async () => {
            assertPage()
            if (typeof params.payload !== 'string' || params.payload.length > 100000) return fail('HOST_PAYLOAD_TOO_LARGE', 'Page helper request exceeds the size limit.')
            const request = JSON.parse(params.payload)
            if (!Number.isSafeInteger(request.id) || request.id < 1 || typeof request.action !== 'string') return fail('HOST_INVALID_PAGE_REQUEST', 'Invalid page helper request.')
            let envelope
            try {
              if (!helper) return fail('HOST_UNSUPPORTED_HELPER', 'Page helpers are not available.')
              envelope = { ok: true, result: await helper(request.action, request.payload || {}, controller.signal) }
            } catch (error) {
              envelope = { ok: false, error: { code: (error as any).code || 'HOST_HELPER_FAILED', message: (error as Error).message } }
            }
            assertPage()
            const encoded = JSON.stringify(envelope)
            if (Buffer.byteLength(encoded) > MAX_BYTES / 2) return fail('HOST_PAYLOAD_TOO_LARGE', 'Page helper response exceeds the size limit.')
            await ctx.sendCDPCommand('Runtime.evaluate', { contextId: world.executionContextId,
              expression: `globalThis[${JSON.stringify(binding + '_reply')}](${request.id},${encoded})` })
          }).catch(error => { controller.abort(error) })
        }
        contents.debugger.on('message', onBinding)
        let response: { result: { value?: string }; exceptionDetails?: unknown }
        try {
          await ctx.sendCDPCommand('Runtime.addBinding', { name: binding, executionContextId: world.executionContextId })
          await ctx.sendCDPCommand('Runtime.evaluate', { contextId: world.executionContextId, expression: `(() => {
            const pending = new Map(); let id = 0;
            globalThis[${JSON.stringify(binding + '_reply')}] = (id, result) => {
              const item = pending.get(id); if (!item) return; pending.delete(id);
              result.ok ? item.resolve(result.result) : item.reject(Object.assign(new Error(result.error.message), {code:result.error.code}));
            };
            globalThis.__webcliHostHelper = (action, payload) => new Promise((resolve, reject) => {
              if (pending.size >= 32) return reject(new Error('Too many pending page helpers.'));
              const current = ++id; pending.set(current, {resolve,reject});
              globalThis[${JSON.stringify(binding)}](JSON.stringify({id:current,action,payload}));
            });
          })()` })
          response = await ctx.sendCDPCommand('Runtime.evaluate', {
            expression: script, contextId: world.executionContextId, awaitPromise: true, returnByValue: true,
          }, 35000)
          await queue
        } finally {
          contents.debugger.removeListener('message', onBinding)
          if (!contents.isDestroyed()) await ctx.sendCDPCommand('Runtime.removeBinding', { name: binding }).catch(() => {})
        }
        invoking = false
        assertPage()
        if (response.exceptionDetails || typeof response.result.value !== 'string') return fail('ADAPTER_EXECUTION_FAILED', 'Page Adapter execution failed; it was not retried.')
        if (Buffer.byteLength(response.result.value) > MAX_BYTES / 2) return fail('HOST_PAYLOAD_TOO_LARGE', 'Adapter result exceeds the size limit.')
        const envelope = JSON.parse(response.result.value)
        if (typeof envelope?.ok !== 'boolean') return fail('HOST_INVALID_PAGE_RESULT', 'Invalid page Adapter result.')
        executionPending = false
        if (!envelope.ok) return fail(envelope.error?.code || 'ADAPTER_EXECUTION_FAILED', envelope.error?.message || 'Page Adapter failed.')
        const navigation = pageContinuation(envelope.result, grant)
        if (!navigation) { completed = true; return envelope.result }
        if (hops >= 4) return fail('HOST_NAVIGATION_LIMIT', 'Adapter exceeded its navigation continuation limit.')
        navigationHosts = navigation.resume ? grant.pageHosts! : grant.hosts
        await navigate(navigation.url)
        if (!navigation.resume) { completed = true; return navigation.result ?? { status: 'navigation_complete', url: contents.getURL() } }
      }
    }, 5000, { signal: controller.signal, deadline: Date.now() + 40000 })
  } finally {
    signal.removeEventListener('abort', abort)
    if (!contents.isDestroyed()) {
      contents.removeListener('will-navigate', guard)
      contents.removeListener('will-redirect', guardRedirect)
      contents.removeListener('did-start-navigation', documentChanged)
      // Destroy only the Adapter-owned document when execution may still be pending.
      if (!completed && (executionPending || controller.signal.aborted)) browserViewManager.destroy(viewId)
    }
  }
}
