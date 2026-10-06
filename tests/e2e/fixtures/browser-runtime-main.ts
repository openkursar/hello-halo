import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerBrowserHandlers } from '../../../src/main/ipc/browser'
import { registerAIBrowserHandlers } from '../../../src/main/ipc/ai-browser'
import { registerBrowserHostHandlers } from '../../../src/main/ipc/browser-host'
import { registerBrowserPolicyHandlers } from '../../../src/main/ipc/browser-policy'
import { setMainWindow } from '../../../src/main/foundation/window.service'
import { initSdk } from '../../../src/main/services/agent/resolved-sdk'
import { browserViewManager } from '../../../src/main/services/browser-view.service'
import {
  createAIBrowserMcpServer, createScopedBrowserContext, getInteractiveBrowserContext,
  releaseInteractiveBrowserContext, listLivePages, type BrowserContext,
} from '../../../src/main/services/ai-browser'

type ContextKind = 'main' | 'human' | 'automation'
interface ToolResult { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }
interface ContextSession {
  context: BrowserContext
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
}

const sessions = new Map<ContextKind, ContextSession>()

async function getSession(kind: ContextKind): Promise<ContextSession> {
  const existing = sessions.get(kind)
  if (existing) return existing
  const context = kind === 'main'
    ? getInteractiveBrowserContext('carrier-main', 'halo-temp')
    : createScopedBrowserContext(kind === 'human' ? { conversationId: 'app-chat:carrier-human', spaceId: 'halo-temp' } : undefined)
  const server = createAIBrowserMcpServer(context, process.env.HALO_DATA_DIR)
  let callTool: ContextSession['callTool']
  if (typeof server.instance.callTool === 'function') {
    callTool = (name, args) => server.instance.callTool(name, args)
  } else {
    const client = new Client({ name: 'carrier-regression', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverTransport)
    await client.connect(clientTransport)
    callTool = async (name, args) => await client.callTool({ name, arguments: args }) as ToolResult
  }
  const session = { context, callTool }
  sessions.set(kind, session)
  return session
}

void app.whenReady().then(async () => {
  await initSdk()
  const window = new BrowserWindow({
    width: 1100, height: 800, show: true,
    webPreferences: {
      preload: process.env.HALO_BROWSER_TEST_PRELOAD,
      webviewTag: true, sandbox: true, nodeIntegration: false,
      contextIsolation: true,
    },
  })
  setMainWindow(window)
  registerBrowserHostHandlers(window)
  registerBrowserHandlers(window)
  registerBrowserPolicyHandlers()
  registerAIBrowserHandlers()
  ipcMain.handle('browser-test:tool', async (_event, { kind, name, args }) => {
    const session = await getSession(kind)
    const result = await session.callTool(name, args)
    return { result, viewId: session.context.getActiveViewId(), pages: listLivePages() }
  })
  ipcMain.handle('browser-test:release', (_event, kind: ContextKind) => {
    const session = sessions.get(kind)
    if (!session) throw new Error(`No context ${kind} to release`)
    if (kind === 'main') releaseInteractiveBrowserContext('carrier-main')
    else session.context.destroy()
    sessions.delete(kind)
    return { states: browserViewManager.getAllStates(), pages: listLivePages() }
  })
  ipcMain.handle('browser-test:state', () => ({ states: browserViewManager.getAllStates(), pages: listLivePages() }))
  await window.loadFile(path.resolve(process.env.HALO_BROWSER_TEST_HTML!))
})

app.on('window-all-closed', () => app.quit())
