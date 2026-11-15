import { createServer, type IncomingHttpHeaders } from 'node:http'
import { test as base, expect } from './browser-site'

export interface LoginRequest {
  path: string
  method: string
  headers: IncomingHttpHeaders
  body: string
}
interface LoginSite { origin: string; requests: LoginRequest[] }

export const test = base.extend<{ loginSite: LoginSite }>({
  loginSite: async ({}, use) => {
    const requests: LoginRequest[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk); if (body.length > 8192) request.destroy() })
      request.on('end', () => {
        const path = new URL(request.url!, 'http://localhost').pathname
        requests.push({ path, method: request.method!, headers: request.headers, body })
        if (requests.length > 200) requests.shift()
        response.setHeader('cache-control', 'no-store')
        if (path === '/worker.js') {
          response.setHeader('content-type', 'text/javascript')
          response.end(`postMessage({ua:navigator.userAgent,brands:navigator.userAgentData?.brands});`)
          return
        }
        if (path === '/login') response.setHeader('set-cookie', 'login-fixture=shared; Path=/; SameSite=Lax')
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(`<!doctype html><meta name="referrer" content="same-origin"><title>Local login fixture</title><h1>Local login fixture</h1><script>
          window.initialCompatibility = { app:typeof chrome?.app?.installState, csi:typeof chrome?.csi, loadTimes:typeof chrome?.loadTimes, node:typeof require, halo:typeof window.halo };
        </script><a id="new-tab" href="/ordinary-tab" target="_blank">Open ordinary tab</a><a id="no-referrer" href="/private-tab" target="_blank" rel="noreferrer">Open private tab</a><script>
          window.fixtureNonce = crypto.randomUUID(); window.messages = [];
          addEventListener('message', event => { if (event.origin === location.origin) messages.push(event.data); });
          window.identity = () => ({ua:navigator.userAgent,brands:navigator.userAgentData?.brands,halo:typeof window.halo,node:typeof require});
          window.workerIdentity = () => new Promise((resolve,reject) => {
            const worker = new Worker('/worker.js');
            const timer=setTimeout(()=>{worker.terminate();reject(new Error('Worker identity timed out'))},5000);
            worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data)};
            worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(new Error('Worker failed'))};
          });
        </script>`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Login fixture requires a TCP address')
    try { await use({ origin: `http://127.0.0.1:${address.port}`, requests }) }
    finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  },
})
export { expect }
