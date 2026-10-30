import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test as base, browserWorkHtml } from './acceptance-browser-work'

type Role = 'target' | 'control'
interface MetadataUpdate { title: string; url: string; navigate: boolean }
interface MetadataSite {
  targetUrl: string
  controlUrl: string
  nextUrl: string
  targetTitle: string
  controlTitle: string
  update(role: Role, title: string, navigate?: boolean): MetadataUpdate
}

export const test = base.extend<{ browserMetadataSite: MetadataSite }>({
  browserMetadataSite: async ({}, use) => {
    const label = randomUUID()
    const titles = { target: `Metadata target ${label}`, control: `Metadata control ${label}` }
    const pending = new Map<Role, MetadataUpdate>()
    const clients = new Map<Role, Set<ServerResponse>>([['target', new Set()], ['control', new Set()]])
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const role: Role = url.searchParams.get('role') === 'control' ? 'control' : 'target'
      if (url.pathname === '/updates') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.flushHeaders()
        clients.get(role)!.add(response)
        response.on('close', () => clients.get(role)!.delete(response))
        const current = pending.get(role)
        if (current) response.write(`data: ${JSON.stringify(current)}\n\n`)
        return
      }
      const frame = url.pathname === '/frame'
      let html = browserWorkHtml(frame ? 'Metadata editing frame' : pending.get(role)?.title ?? titles[role], frame)
      if (!frame) html = html.replace('</body>', `<script>
const updates = new EventSource('/updates?role=${role}');
updates.onmessage = event => {
  const update = JSON.parse(event.data);
  if (update.navigate && location.href !== update.url) { location.assign(update.url); return; }
  document.title = update.title;
  if (!update.navigate && location.href !== update.url) history.replaceState(null, '', update.url);
};
</script></body>`)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let revision = 0
    try {
      await use({
        targetUrl: `${origin}/page?role=target`, controlUrl: `${origin}/page?role=control`, nextUrl: `${origin}/next?role=target`,
        targetTitle: titles.target, controlTitle: titles.control,
        update(role, title, navigate = false) {
          const update = { title, url: `${origin}/${navigate ? 'next' : 'page'}?role=${role}&revision=${++revision}`, navigate }
          pending.set(role, update)
          for (const client of clients.get(role)!) client.write(`data: ${JSON.stringify(update)}\n\n`)
          return update
        },
      })
    } finally {
      for (const group of clients.values()) for (const client of group) client.end()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  },
})

interface MetadataProbe {
  events: Array<{ viewId: string; state: { title?: string; url?: string } }>
  dispose(): void
}
type MetadataWindow = Window & { halo: HaloAPI; acceptanceBrowserMetadata?: MetadataProbe }

export async function observeBrowserMetadata(page: Page) {
  await page.evaluate(() => {
    const holder = window as unknown as MetadataWindow
    holder.acceptanceBrowserMetadata?.dispose()
    const probe: MetadataProbe = { events: [], dispose: () => {} }
    probe.dispose = holder.halo.onBrowserStateChange(value => {
      const event = value as { viewId: string; state: { title?: string; url?: string } }
      probe.events.push({ viewId: event.viewId, state: { title: event.state.title, url: event.state.url } })
      if (probe.events.length > 64) probe.events.shift()
    })
    holder.acceptanceBrowserMetadata = probe
  })
  return async () => page.evaluate(() => {
    const holder = window as unknown as MetadataWindow
    holder.acceptanceBrowserMetadata?.dispose()
    delete holder.acceptanceBrowserMetadata
  })
}

export async function metadataWasReceived(page: Page, viewId: string, update: MetadataUpdate) {
  return page.evaluate(({ viewId, update }) => (window as unknown as MetadataWindow).acceptanceBrowserMetadata!.events.some(event => event.viewId === viewId && event.state.title === update.title && event.state.url === update.url), { viewId, update })
}
