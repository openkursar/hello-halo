import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AcceptanceApp } from './acceptance-app'
import { expect } from './acceptance-app'
import { installRemoteLoopbackGuard, readRemoteLoopbackGuard, restoreRemoteLoopbackGuard } from './acceptance-remote-desktop'

export async function triggerAssignmentWebhook(page: Page, session: AcceptanceApp, appId: string) {
  const hook = `assignment-${randomUUID()}`
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await session.app.evaluate(installRemoteLoopbackGuard)
  try {
    const updated = await page.evaluate(({ appId, hook }) => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateSpec({ appId, specPatch: { subscriptions: [{ id: 'assignment-hook', source: { type: 'webhook', config: { path: hook } } }] } }), { appId, hook })
    expect(updated.success).toBe(true)
    const enabled = await page.evaluate(port => (globalThis as unknown as { halo: HaloAPI }).halo.enableRemoteAccess(port), port)
    expect(enabled.success).toBe(true)
    const binding = await session.app.evaluate(readRemoteLoopbackGuard)
    expect(binding.violations).toEqual([])
    expect(binding.attempts.filter(attempt => attempt.listening).every(attempt => attempt.actual?.address === '127.0.0.1')).toBe(true)
    const response = await fetch(`http://127.0.0.1:${port}/hooks/${hook}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dedupKey: randomUUID() }) })
    expect(response.ok).toBe(true)
  } finally {
    const disabled = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.disableRemoteAccess())
    expect(disabled.success).toBe(true)
    await session.app.evaluate((_electron, remotePort) => {
      const guard = (globalThis as unknown as { acceptanceRemoteBinding: { restore(port?: number): unknown } }).acceptanceRemoteBinding
      return guard.restore(remotePort)
    }, port)
  }
}
