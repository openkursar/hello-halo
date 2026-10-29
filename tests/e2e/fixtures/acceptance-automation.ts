import { createServer, request as requestHttp, type ClientRequest } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ActivityEntry, AutomationAppState, AutomationRunWithSummary, InstalledApp } from '../../../src/shared/apps/app-types'
import { test as base, expect, type AcceptanceApp } from './acceptance-app'
import { startAcceptanceModel } from './acceptance-model'
import { openManagedPerson } from './acceptance-management'

export const providerFailure = 'The local acceptance provider rejected this run.'

interface AutomationFault {
  rejectInference: boolean
  rejected: number
}

interface AutomationFixture {
  appId: string
  name: string
  session: AcceptanceApp
}

interface Fixtures {
  automationInterval: string
  automationFault: AutomationFault
  automation: AutomationFixture
}

export const test = base.extend<Fixtures>({
  automationInterval: ['24h', { option: true }],
  automationFault: async ({}, use) => { await use({ rejectInference: false, rejected: 0 }) },
  model: async ({ automationFault }, use, testInfo) => {
    const model = await startAcceptanceModel()
    const pending = new Set<ClientRequest>()
    const errors: string[] = []
    const receipts: Array<{ method: string; path: string; status: number }> = []
    const modelOrigin = new URL(model.url).origin
    let cancelled = 0
    const server = createServer((incoming, outgoing) => {
      const requestTarget = incoming.url ?? '/'
      const originForm = requestTarget.startsWith('/') && !requestTarget.startsWith('//') && !requestTarget.includes('\\')
      const target = originForm ? new URL(requestTarget, model.url) : null
      if (!target || target.origin !== modelOrigin) {
        receipts.push({ method: incoming.method ?? 'GET', path: '[rejected-target]', status: 400 })
        incoming.resume()
        outgoing.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          error: { type: 'invalid_request_error', message: 'Only local origin-form model paths are accepted' },
        }))
        return
      }
      const route = target.pathname
      const inference = incoming.method === 'POST' && (route.endsWith('/messages') || route.endsWith('/chat/completions'))
      if (automationFault.rejectInference && inference) {
        automationFault.rejected++
        receipts.push({ method: incoming.method!, path: route, status: 400 })
        incoming.resume()
        outgoing.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          error: { type: 'invalid_request_error', message: providerFailure },
        }))
        return
      }
      const upstream = requestHttp(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        receipts.push({ method: incoming.method ?? 'GET', path: route, status: response.statusCode ?? 502 })
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.on('error', error => {
          if (outgoing.destroyed) return
          errors.push(error.message)
          console.error('[AcceptanceAutomation] Model response failed:', error.message)
          outgoing.destroy()
        })
        response.pipe(outgoing)
      })
      pending.add(upstream)
      upstream.once('close', () => pending.delete(upstream))
      upstream.on('error', error => {
        if (incoming.aborted || outgoing.destroyed) return
        errors.push(error.message)
        console.error('[AcceptanceAutomation] Model forwarding failed:', error.message)
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'Content-Type': 'application/json' })
        outgoing.end(JSON.stringify({ error: { message: 'Local model forwarding failed' } }))
      })
      incoming.once('aborted', () => upstream.destroy())
      incoming.on('error', error => {
        if (incoming.aborted) return
        errors.push(error.message)
        console.error('[AcceptanceAutomation] Model request failed:', error.message)
        upstream.destroy()
        outgoing.destroy()
      })
      outgoing.once('close', () => {
        if (!outgoing.writableFinished) cancelled++
        upstream.destroy()
      })
      incoming.pipe(upstream)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address() as { port: number }
      await use({ ...model, url: `http://127.0.0.1:${address.port}` })
      expect(errors, 'The provider substitute must not hide unintended forwarding errors').toEqual([])
    } finally {
      server.closeAllConnections()
      for (const upstream of pending) upstream.destroy()
      try {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      } finally {
        await model.close()
        await testInfo.attach('automation-provider-requests', { body: JSON.stringify({ receipts, rejected: automationFault.rejected, cancelled, errors }, null, 2), contentType: 'application/json' })
      }
    }
  },
  automation: async ({ acceptanceApp, automationInterval }, use) => {
    const page = acceptanceApp.window
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.appGetOverview().then(result => result.success)), {
      timeout: 30000, message: 'The real automation runtime must be ready before installation can activate its schedule',
    }).toBe(true)
    const name = 'Acceptance independent worker'
    const installed = await page.evaluate(async ({ name, every }) => {
      const api = (globalThis as unknown as { halo: HaloAPI }).halo
      const result = await api.appInstall({ spaceId: 'halo-temp', spec: {
        spec_version: '1', name, version: '1.0.0', author: 'Acceptance tests',
        description: 'A local worker for isolated execution and scheduling checks.', type: 'automation',
        system_prompt: 'Follow the local acceptance task. Use report_to_user when the requested work is complete.',
        subscriptions: [{ id: 'acceptance-schedule', source: { type: 'schedule', config: { every } } }],
        requires: {}, config_schema: [], permissions: [],
      } })
      if (!result.success) throw new Error(`Could not install automation precondition: ${result.error}`)
      const data = result.data as { appId: string; activationWarning?: string }
      if (data.activationWarning) throw new Error(`Automation did not activate: ${data.activationWarning}`)
      const updated = await api.appUpdateOverrides({ appId: data.appId, overrides: { notificationLevel: 'none' } })
      if (!updated.success) throw new Error(`Could not disable desktop notification precondition: ${updated.error}`)
      return data
    }, { name, every: automationInterval })
    await use({ appId: installed.appId, name, session: acceptanceApp })
  },
  window: async ({ automation }, use) => { await use(automation.session.window) },
})

export { expect } from '@playwright/test'
export { acceptance } from './acceptance-app'

export async function openAutomation(page: Page, automation: AutomationFixture) {
  await openManagedPerson(page, automation.name)
  await page.getByRole('button', { name: 'Work activity', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recent activity', exact: true })).toBeVisible()
}

export async function readAutomationState(page: Page, appId: string): Promise<AutomationAppState> {
  const result = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGetState(id), appId)
  expect(result.success).toBe(true)
  return result.data as AutomationAppState
}

export async function readAutomationRuns(page: Page, appId: string): Promise<AutomationRunWithSummary[]> {
  const result = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId: id }), appId)
  expect(result.success).toBe(true)
  return result.data!
}

export async function readAutomationActivity(page: Page, appId: string): Promise<ActivityEntry[]> {
  const result = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGetActivity({ appId: id }), appId)
  expect(result.success).toBe(true)
  return result.data as ActivityEntry[]
}

export async function readAutomationPerson(page: Page, appId: string): Promise<InstalledApp> {
  const result = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id), appId)
  expect(result.success).toBe(true)
  return result.data as InstalledApp
}

export async function readAutomationTranscript(page: Page, appId: string, runId: string) {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appGetSession(input), { appId, runId })
  expect(result.success).toBe(true)
  return result.data as Array<{ id: string; role: string; content: string }>
}

export async function startAutomation(page: Page, appId: string) {
  const previous = new Set((await readAutomationRuns(page, appId)).map(run => run.runId))
  await page.getByRole('button', { name: 'Run now', exact: true }).click()
  await expect.poll(async () => (await readAutomationRuns(page, appId)).filter(run => !previous.has(run.runId)).length).toBe(1)
  return (await readAutomationRuns(page, appId)).find(run => !previous.has(run.runId))!
}

export async function waitForAutomationResult(page: Page, appId: string, runId: string, status: 'ok' | 'error') {
  await expect.poll(async () => (await readAutomationRuns(page, appId)).find(run => run.runId === runId)?.status, { timeout: 45000 }).toBe(status)
  await expect.poll(async () => {
    const state = await readAutomationState(page, appId)
    return state.status === 'running' || state.status === 'queued'
  }).toBe(false)
  return (await readAutomationRuns(page, appId)).find(run => run.runId === runId)!
}

export async function openAutomationProcess(page: Page, appId: string, runId: string) {
  const state = await readAutomationState(page, appId)
  if (state.runningRunId === runId) {
    const active = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Independent execution in progress', exact: true }) })
    await active.getByRole('button', { name: 'View process', exact: true }).click()
  } else {
    const entry = (await readAutomationActivity(page, appId)).find(entry => entry.runId === runId && (entry.type === 'run_complete' || entry.type === 'run_error'))
    expect(entry, 'A finished execution must have a readable activity record').toBeTruthy()
    await page.locator(`[id="activity-${entry!.id}"]`).getByRole('button', { name: 'View process', exact: true }).click()
  }
  await expect(page.locator('textarea')).toBeVisible()
}

export function createAutomationToolGate(profile: string, name: string) {
  const ready = join(profile, `${name}-ready`)
  const released = join(profile, `${name}-released`)
  const script = join(profile, `${name}.cjs`)
  writeFileSync(script, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready')`,
    'const started = Date.now()',
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) { clearInterval(timer); process.stdout.write('AUTOMATION_TOOL_RELEASED'); } else if (Date.now() - started > 45000) { clearInterval(timer); process.stderr.write('The automation test did not release its tool'); process.exitCode = 1; } }, 40)`,
  ].join('\n'))
  return {
    command: `"${process.execPath}" "${script}"`,
    started: () => existsSync(ready),
    release: () => writeFileSync(released, 'release'),
  }
}
