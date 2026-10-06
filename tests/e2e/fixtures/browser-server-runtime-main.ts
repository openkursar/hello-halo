import { app, BrowserWindow, session, webContents } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { applyServerModeSwitches, bootServerMode, getBootstrapStatus } from '../../../src/main/bootstrap'
import { initializeApp } from '../../../src/main/foundation/config.service'
import { getMainWindow } from '../../../src/main/foundation/window.service'
import { isServerMode } from '../../../src/main/foundation/runtime-mode'
import { initSdk } from '../../../src/main/services/agent/resolved-sdk'
import { browserViewManager } from '../../../src/main/services/browser-view.service'
import { browserHostManager } from '../../../src/main/services/browser-host'
import { getRemoteAccessStatus } from '../../../src/main/services/remote'
import { getSearchContext } from '../../../src/main/services/web-search'
import {
  createAIBrowserMcpServer, createScopedBrowserContext, getInteractiveBrowserContext,
  releaseInteractiveBrowserContext, listLivePages, type BrowserContext,
} from '../../../src/main/services/ai-browser'
import type { BrowserToolOutcome, ContextKind } from './browser-runtime'

interface ContextSession {
  context: BrowserContext
  callTool: (name: string, args: Record<string, unknown>) => Promise<BrowserToolOutcome['result']>
}

const contexts = new Map<ContextKind, ContextSession>()

async function contextSession(kind: ContextKind): Promise<ContextSession> {
  const existing = contexts.get(kind)
  if (existing) return existing
  const context = kind === 'main'
    ? getInteractiveBrowserContext('carrier-server-main', 'halo-temp')
    : createScopedBrowserContext(kind === 'human' ? { conversationId: 'app-chat:carrier-server-human', spaceId: 'halo-temp' } : undefined)
  const server = createAIBrowserMcpServer(context, process.env.HALO_DATA_DIR)
  let callTool: ContextSession['callTool']
  if (typeof server.instance.callTool === 'function') {
    callTool = (name, args) => server.instance.callTool(name, args)
  } else {
    const client = new Client({ name: 'server-carrier-regression', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverTransport)
    await client.connect(clientTransport)
    callTool = async (name, args) => await client.callTool({ name, arguments: args }) as BrowserToolOutcome['result']
  }
  const created = { context, callTool }
  contexts.set(kind, created)
  return created
}

const driver = {
  ready: false,
  error: '',
  async tool(kind: ContextKind, name: string, args: Record<string, unknown> = {}): Promise<BrowserToolOutcome> {
    const owner = await contextSession(kind)
    return { result: await owner.callTool(name, args), viewId: owner.context.getActiveViewId(), pages: listLivePages() }
  },
  release(kind: ContextKind): void {
    const owner = contexts.get(kind)
    if (!owner) throw new Error(`No server context ${kind}`)
    if (kind === 'main') releaseInteractiveBrowserContext('carrier-server-main')
    else owner.context.destroy()
    contexts.delete(kind)
  },
  closePages(): void { browserViewManager.destroyAll() },
  state() {
    const pages = browserViewManager.getAllStates()
    const guests = pages.map(page => {
      const guest = browserViewManager.getWebContents(page.id)!
      const host = guest.hostWebContents!
      const attachment = browserHostManager.ready(host).find(record => record.id === page.id)
      return { id: page.id, contentsId: guest.id, hostId: host.id, frameLeaseId: attachment?.frameLeaseId, hostVisible: BrowserWindow.fromWebContents(host)?.isVisible() }
    })
    const remote = getRemoteAccessStatus()
    return {
      serverMode: isServerMode(), mainWindow: getMainWindow()?.id ?? null,
      windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, visible: window.isVisible(), url: window.webContents.getURL() })),
      guests, pages, hasUi: [...contexts.entries()].map(([kind, owner]) => ({ kind, hasUi: owner.context.hasUi })),
      remote: { enabled: remote.enabled, port: remote.server.port }, bootstrap: getBootstrapStatus(),
      webContents: webContents.getAllWebContents().map(contents => ({ id: contents.id, type: contents.getType() })),
    }
  },
  async search(origin: string) {
    const browser = session.fromPartition('persist:browser')
    await browser.protocol.handle('https', request => {
      if (!request.url.startsWith('https://www.bing.com/search?')) return new Response('Unexpected test request', { status: 502 })
      return new Response(`<html><head><title>Carrier search fixture</title></head><body><ol id="b_results"><li class="b_algo"><h2><a href="${origin}/carrier-search-result">Carrier search result</a></h2><div class="b_caption"><p>Deterministic hidden search content.</p></div></li></ol></body></html>`, { headers: { 'content-type': 'text/html' } })
    })
    try { return await getSearchContext().search('carrier search fixture', { engine: 'bing', maxResults: 1 }) }
    finally { browser.protocol.unhandle('https') }
  },
}

export type BrowserServerRuntimeDriver = typeof driver

;(globalThis as unknown as { browserServerTest: typeof driver }).browserServerTest = driver
applyServerModeSwitches(app)
// Match the production server lifecycle after the last temporary host closes.
app.on('window-all-closed', () => {})
void app.whenReady().then(async () => {
  await initializeApp()
  await initSdk()
  await bootServerMode()
  driver.ready = true
}).catch(error => {
  driver.error = error instanceof Error ? error.message : String(error)
  console.error('[ServerFixture] Headless boot failed', error)
})
