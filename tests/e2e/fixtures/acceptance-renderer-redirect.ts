import { createServer as createHttpServer, type Server } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { ElectronApplication } from '@playwright/test'

interface RedirectGuard { connections(): number; restore(): void }
interface RedirectGlobal { acceptanceRendererRedirect?: RedirectGuard }

// Serialized into the owned Electron process; it must not capture this module's imports.
export function installRendererRedirect(_electron: unknown, rendererPort: number): void {
  const state = globalThis as unknown as RedirectGlobal
  if (state.acceptanceRendererRedirect) throw new Error('The owned process already redirects the development renderer port')
  const network = process.getBuiltinModule('node:net') as typeof import('node:net')
  const original = network.Socket.prototype.connect
  const loopback = ['127.0.0.1', 'localhost', 'localhost.', '::1', '::ffff:127.0.0.1']
  let connections = 0
  const redirected = function (this: import('node:net').Socket, ...args: unknown[]) {
    const normalized = (Array.isArray(args[0]) ? args[0] : args) as unknown[]
    const options = normalized[0] as { port?: unknown; host?: unknown; hostname?: unknown; path?: unknown } | null
    let host: unknown
    if (options && typeof options === 'object' && options.path === undefined && Number(options.port) === 5173) host = options.host ?? options.hostname
    else if (typeof normalized[0] !== 'object' && Number(normalized[0]) === 5173) host = typeof normalized[1] === 'string' ? normalized[1] : undefined
    else return Reflect.apply(original, this, args)
    // An unrecognized target must never fall back to the developer's server.
    if (typeof host !== 'string' || !loopback.includes(host)) throw new Error(`Renderer redirect refused port 5173 on host ${String(host)}`)
    if (typeof normalized[0] === 'object') normalized[0] = { ...options, port: rendererPort, host: '127.0.0.1', hostname: '127.0.0.1' }
    else { normalized[0] = rendererPort; normalized[1] = '127.0.0.1' }
    connections++
    return Reflect.apply(original, this, args)
  }
  network.Socket.prototype.connect = redirected as typeof original
  state.acceptanceRendererRedirect = {
    connections: () => connections,
    restore() {
      if (network.Socket.prototype.connect !== redirected) throw new Error('The owned socket implementation changed while the renderer redirect was installed')
      network.Socket.prototype.connect = original
      delete state.acceptanceRendererRedirect
    },
  }
}

export function restoreRendererRedirect(): number {
  const guard = (globalThis as unknown as RedirectGlobal).acceptanceRendererRedirect
  if (!guard) throw new Error('The owned process has no renderer redirect to restore')
  const connections = guard.connections()
  guard.restore()
  return connections
}

export interface RendererAssets { port: number; close(): Promise<number> }

/**
 * Source builds proxy remote pages to 5173. Serve the built renderer on a free
 * port and remap only the owned app's sockets, never binding or contacting the
 * developer's server.
 */
export async function serveBuiltRenderer(app: ElectronApplication): Promise<RendererAssets> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const server: Server = createHttpServer(express().use(express.static(resolve(root, 'out/renderer'))))
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const port = (server.address() as { port: number }).port
  const stop = async () => {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  }
  try { await app.evaluate(installRendererRedirect, port) }
  catch (error) { await stop(); throw error }
  return {
    port,
    async close() {
      try {
        const connections = await app.evaluate(restoreRendererRedirect)
        if (connections < 1) throw new Error('The remote page never reached the built renderer through the redirect')
        return connections
      } finally { await stop() }
    },
  }
}
