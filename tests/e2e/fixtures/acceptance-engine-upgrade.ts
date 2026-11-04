import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, TestInfo } from '@playwright/test'
import { expect, type AcceptanceApp } from './acceptance-app'

export async function assertNoCcRecoveryNotice(page: Page) {
  // A negative assertion must survive asynchronous availability rendering before any send.
  for (let sample = 0; sample < 12; sample++) {
    await expect(page.getByText(/^(Set up Claude Code|Install or connect Claude Code|Continue with Halo SDK|Halo SDK is currently running\.)/)).toHaveCount(0)
    await page.waitForTimeout(250)
  }
}

export const engineDiscoveryObserver = fileURLToPath(new URL('./engine-discovery-observer.cjs', import.meta.url))

export async function assertEngineDiscovery(session: AcceptanceApp, info: TestInfo, selectedPaths: string[] = []) {
  const evidence = JSON.parse(readFileSync(join(session.profile, '.halo', 'engine-discovery-observation.json'), 'utf8')) as {
    pid: number; truncated: boolean; operations: Array<{ operation: string; path: string }>
  }
  await info.attach('engine-discovery-observation', { body: JSON.stringify(evidence), contentType: 'application/json' })
  expect(evidence.pid, 'Observation must belong to the restarted application').toBe(session.app.process().pid)
  expect(evidence.truncated).toBe(false)
  expect(evidence.operations.filter(item => item.operation === 'opendir'), 'No runtime discovery directories may be traversed').toEqual([])
  expect(evidence.operations.filter(item => !selectedPaths.includes(item.path)), 'Only the explicitly selected runtime may be inspected').toEqual([])
  if (selectedPaths.length) expect(evidence.operations.some(item => selectedPaths.includes(item.path))).toBe(true)
}
