import { createServer, createConnection, type Socket } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { BrowserContext, Page } from '@playwright/test'
import { test as base, expect } from './acceptance-app'
import type { HaloAPI } from '../../../src/preload'

interface RemoteStatus { server: { port: number; token: string | null; running: boolean } }
interface RemoteFixtures {
  remote: {
    page: Page
    context: BrowserContext
    url: string
    login(code?: string): Promise<void>
    disconnect(): void
    reconnect(): void
  }
}

async function freePort() {
  const listener = createServer()
  await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done) })
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()))
  return port
}

async function startLink(port: number) {
  let online = true
  const sockets = new Set<Socket>()
  const events: Array<{ type: string; code?: string }> = []
  const server = createServer(client => {
    if (!online) { client.destroy(); return }
    const target = createConnection({ port, host: '127.0.0.1' })
    for (const socket of [client, target]) {
      sockets.add(socket)
      socket.on('error', (error: NodeJS.ErrnoException) => { events.push({ type: 'connection-error', code: error.code }) })
      socket.once('close', () => { sockets.delete(socket); client.destroy(); target.destroy() })
    }
    client.pipe(target).pipe(client)
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    events,
    disconnect() { online = false; events.push({ type: 'offline' }); for (const socket of sockets) socket.destroy() },
    reconnect() { online = true; events.push({ type: 'online' }) },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    },
  }
}

export const test = base.extend<RemoteFixtures>({
  remote: async ({ acceptanceApp, browser }, use, testInfo) => {
    const packaged = await acceptanceApp.app.evaluate(({ app }) => app.isPackaged)
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    // Development remote access proxies this port. Serve the built renderer unchanged.
    const assets = packaged ? null : createHttpServer(express().use(express.static(resolve(root, 'out/renderer'))))
    if (assets) await new Promise<void>((done, reject) => { assets.once('error', reject); assets.listen(5173, '127.0.0.1', done) })
    let link: Awaited<ReturnType<typeof startLink>> | undefined
    let context: BrowserContext | undefined
    try {
      const enabled = await acceptanceApp.window.evaluate(async port => (globalThis as unknown as { halo: HaloAPI }).halo.enableRemoteAccess(port), await freePort())
      expect(enabled.success).toBe(true)
      const status = enabled.data as RemoteStatus
      expect(status.server.running).toBe(true)
      expect(status.server.token).toBeTruthy()
      link = await startLink(status.server.port)
      context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
      const page = await context.newPage()
      await page.goto(link.url)
      await expect(page.getByPlaceholder('Access Code', { exact: true })).toBeVisible()
      await use({
        page, context, url: link.url,
        async login(code = status.server.token!) {
          await page.getByPlaceholder('Access Code', { exact: true }).fill(code)
          await page.getByRole('button', { name: 'Connect', exact: true }).click()
          await expect(page.getByRole('button', { name: 'Conversation', exact: true }).first()).toBeVisible({ timeout: 30000 })
          expect(await page.evaluate(() => 'halo' in globalThis)).toBe(false)
        },
        disconnect: () => link!.disconnect(),
        reconnect: () => link!.reconnect(),
      })
      await page.screenshot({ path: testInfo.outputPath('remote-final-window.png') })
    } finally {
      await context?.close()
      if (link) {
        await testInfo.attach('remote-transport', { body: JSON.stringify({ renderer: packaged ? 'packaged' : 'built-assets-development-proxy', events: link.events }), contentType: 'application/json' })
        await link.close()
      }
      if (assets) {
        assets.closeAllConnections()
        await new Promise<void>((done, reject) => assets.close(error => error ? reject(error) : done()))
      }
    }
  },
})

export { expect } from '@playwright/test'
