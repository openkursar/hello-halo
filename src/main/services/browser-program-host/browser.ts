import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext } from '../ai-browser'
import { browserViewManager } from '../browser-view.service'
import { isUrlAllowedByPolicy } from '../browser-policy.service'
import { fail } from './protocol'
import { assertNavigationComplete, navigateForProgram } from './navigation'

const sessionName = z.string().min(1).max(128).default('default')
const scoped = { session: sessionName }
const target = { ...scoped, ref: z.string().min(1) }
const schemas = {
  help: z.object({}).strict(), doctor: z.object({}).strict(), tabs: z.object({}).strict(), sessions: z.object({}).strict(),
  open: z.object({ ...scoped, url: z.string().url() }).strict(),
  bind: z.object({ ...scoped, tabId: z.string() }).strict(),
  unbind: z.object(scoped).strict(), close: z.object(scoped).strict(),
  state: z.object({ ...scoped, verbose: z.boolean().optional() }).strict(),
  click: z.object(target).strict(), hover: z.object(target).strict(),
  fill: z.object({ ...target, value: z.string() }).strict(),
  keys: z.object({ ...scoped, key: z.string() }).strict(),
  eval: z.object({ ...scoped, expression: z.string().max(100000) }).strict(),
  extract: z.object({ ...scoped, maxChars: z.number().int().min(1).max(100000).default(20000) }).strict(),
  wait: z.object({ ...scoped, kind: z.enum(['text', 'selector']), value: z.string(), timeoutMs: z.number().int().min(1).max(30000).default(10000) }).strict(),
  screenshot: z.object(scoped).strict(),
}
interface Binding { viewId: string; owned: boolean }
const bindings = new WeakMap<BrowserContext, Map<string, Binding>>()

function sessionBindings(ctx: BrowserContext): Map<string, Binding> {
  let value = bindings.get(ctx)
  if (!value) { value = new Map(); bindings.set(ctx, value) }
  for (const [name, binding] of value) {
    if (!browserViewManager.getState(binding.viewId) || !ctx.canReachView(binding.viewId)) value.delete(name)
  }
  return value
}

export async function acquireAdapterPage(ctx: BrowserContext, name: string): Promise<string> {
  const sessions = sessionBindings(ctx)
  const key = `adapter:${name}`
  const existing = sessions.get(key)
  if (existing) {
    if (!existing.owned) return fail('HOST_PAGE_NOT_OWNED', 'Adapter execution requires its own page.')
    ctx.setActiveViewId(existing.viewId)
    return existing.viewId
  }
  if (sessions.size >= 32) return fail('HOST_SESSION_LIMIT', 'Close a named browser session before opening another.')
  const page = await ctx.openPage('about:blank', 'pc')
  sessions.set(key, { viewId: page.viewId, owned: true })
  return page.viewId
}

export async function runBrowserCommand(ctx: BrowserContext, command: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const schema = schemas[command as keyof typeof schemas]
  if (!schema) return fail('HOST_UNSUPPORTED_COMMAND', 'Use browser.help for supported host commands.')
  const parsed = schema.safeParse(input)
  if (!parsed.success) return fail('INVALID_ARGS', 'Arguments do not match this host command; use browser.help.')
  const args = parsed.data as Record<string, any>
  if (['open', 'bind'].includes(command) && args.session.startsWith('adapter:')) return fail('HOST_SESSION_RESERVED', 'Adapter sessions are created by Adapter commands.')
  const sessions = sessionBindings(ctx)
  if (command === 'doctor') return { host: 'halo', protocol: 1, browser: 'embedded', extensionRequired: false,
    adapterCapabilities: { helpers: ['backend_fetch', 'browser_fetch', 'cookies_get', 'storage_get', 'main_world_eval', 'download', 'set_file_input'],
      provider: 'Selected CLI distribution owns host_cli_call support', siteValidation: 'unverified',
      unsupportedContinuations: ['__webcli_page_query'],
      upload: 'Confirmed write commands only; files are absolute paths the program supplies',
      storage: { local: 'Persistent browser partition', session: 'Profile cache scoped to Adapter and origin; forceRefresh invalidates old values, cacheOnly never opens a page; site authentication unverified' },
      redirects: 'manual', maxResponseBytes: 5 * 1024 * 1024 } }
  if (command === 'help') return {
    host: 'halo', usage: 'webcli call browser.<command> --args <JSON>', session: 'default when omitted',
    commands: Object.fromEntries(Object.entries(schemas).map(([key, value]) => [key, Object.keys(value.shape)])),
    targeting: 'state returns Halo snapshot refs. Use the latest ref for click, fill and hover. Selectors and frame targeting are not supported for these commands.',
    eval: 'expression is JavaScript expression text; async expressions may return a Promise.',
    login: 'Open the login URL in this host browser, let the user sign in, then retry a read. Never automatically retry a write.',
  }
  if (command === 'tabs') return ctx.visibleViewStates().map(page => ({ tabId: page.id, url: page.url, title: page.title }))
  if (command === 'sessions') return [...sessions].map(([session, value]) => ({ session, tabId: value.viewId, owned: value.owned }))
  if (command === 'bind') {
    if (!ctx.visibleViewStates().some(page => page.id === args.tabId)) return fail('HOST_PAGE_UNAVAILABLE', 'This page is not visible to the calling context.')
    if (sessions.has(args.session)) return fail('HOST_SESSION_EXISTS', 'Release the existing named session before binding another page.')
    if ([...sessions.values()].some(binding => binding.viewId === args.tabId)) return fail('HOST_PAGE_BOUND', 'This page already has a named session.')
    sessions.set(args.session, { viewId: args.tabId, owned: false })
    return { tabId: args.tabId }
  }
  const binding = sessions.get(args.session)
  if (command === 'open') {
    const url = new URL(args.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail('INVALID_URL', 'Use an HTTP(S) URL without embedded credentials.')
    if (!isUrlAllowedByPolicy(url.href)) return fail('BROWSER_POLICY_BLOCKED', 'Navigation blocked by browser policy.')
    if (binding && !binding.owned) return fail('HOST_PAGE_NOT_OWNED', 'Opening a URL cannot navigate a user-bound page. Use a new session.')
    let fellBack = false
    if (binding) {
      ctx.setActiveViewId(binding.viewId)
    } else {
      if (sessions.size >= 32) return fail('HOST_SESSION_LIMIT', 'Close a named browser session before opening another.')
      const page = await ctx.openPage('about:blank', 'pc')
      fellBack = page.fellBack
      sessions.set(args.session, { viewId: page.viewId, owned: true })
    }
    signal.throwIfAborted()
    const viewId = sessions.get(args.session)!.viewId
    // Await this navigation's loadURL result, not the attachment document's
    // loading events. Shared browser state retains the host's original behavior.
    await navigateForProgram(viewId, url.href, signal)
    signal.throwIfAborted()
    if (!ctx.canReachView(viewId) || ctx.getActiveViewId() !== viewId) return fail('HOST_PAGE_CHANGED', 'The active page changed during navigation.')
    await ctx.waitForNavigation(30000)
    signal.throwIfAborted()
    assertNavigationComplete(sessions.get(args.session)!.viewId)
    return { session: args.session, tabId: sessions.get(args.session)!.viewId, fellBack, ...await ctx.getPageInfo() }
  }
  if (!binding) return fail('HOST_SESSION_MISSING', 'Open or bind a named browser session first.')
  ctx.setActiveViewId(binding.viewId)
  if (command === 'unbind' || command === 'close') {
    if (command === 'close' && binding.owned) browserViewManager.destroy(binding.viewId)
    sessions.delete(args.session)
    return { closed: command === 'close' && binding.owned, released: true }
  }
  switch (command) {
    case 'state': return { snapshot: (await ctx.createSnapshot(args.verbose)).format(args.verbose), ...await ctx.getPageInfo() }
    case 'click': await ctx.clickElement(args.ref); break
    case 'hover': await ctx.hoverElement(args.ref); break
    case 'fill': return ctx.fillElement(args.ref, args.value)
    case 'keys': await ctx.pressKey(args.key); break
    case 'eval': return ctx.evaluateScript(`() => (${args.expression})`)
    case 'extract': return ctx.evaluateScript('(limit) => document.body.innerText.slice(0, limit)', [args.maxChars])
    case 'wait':
      if (args.kind === 'text') await ctx.waitForText(args.value, args.timeoutMs)
      else await ctx.waitForElement(args.value, args.timeoutMs)
      break
    case 'screenshot': {
      const capture = await ctx.captureScreenshot({ format: 'png' })
      signal.throwIfAborted()
      const bytes = Buffer.from(capture.data, 'base64')
      const ext = capture.mimeType === 'image/png' ? 'png' : 'jpg'
      const filePath = join(ctx.getDownloadDir(), `screenshot-${randomUUID()}.${ext}`)
      await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600, signal })
      return { filePath, mimeType: capture.mimeType, bytes: bytes.length }
    }
  }
  return { done: true }
}
