import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HaloAPI } from '../../../src/preload'
import type { TerminalInfo, TerminalLifecycleEvent } from '../../../src/shared/types/terminal'
import { createTestConfigDir, getAppEntryPath, launchElectronApp, cleanupTestConfigDir } from './electron'
import { trackManagementApp, closeManagementApp, type OwnedManagementApp } from './acceptance-management-process'
import { startAcceptanceModel, type AcceptanceModel } from './acceptance-model'
import { ownedPtyProgram, type OwnedPtyProgram } from './acceptance-pty-program'
import { openFromHeaderMenu } from '../../perf/lib/open-artifact'

export interface TerminalSessionApp {
  app: ElectronApplication
  profile: string
  window: Page
  programs: OwnedPtyProgram[]
  sessionIds: Set<string>
  program(label: string): OwnedPtyProgram
}

interface Fixtures {
  terminalEnvironment: void
  model: AcceptanceModel
  terminalApp: TerminalSessionApp
  window: Page
}

interface ProbeWindow {
  halo: HaloAPI
  acceptanceProbe: {
    turns: Array<{ conversationId: string; spaceId: string; completed: boolean }>
    errors: unknown[]
    terminals: TerminalLifecycleEvent[]
  }
}

export const test = base.extend<Fixtures>({
  terminalEnvironment: [async ({}, use) => {
    const names = ['BASH_ENV', 'ENV', 'ZDOTDIR', 'NODE_OPTIONS', ...(process.platform === 'darwin' ? ['SHELL'] : [])]
    const previous = new Map(names.map(name => [name, process.env[name]]))
    for (const name of names) delete process.env[name]
    if (process.platform === 'darwin') process.env.SHELL = '/bin/bash'
    try { await use() }
    finally { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  }, { auto: true }],
  model: async ({}, use) => {
    const model = await startAcceptanceModel()
    try { await use(model) } finally { await model.close() }
  },
  terminalApp: async ({ model }, use, info) => {
    const entry = getAppEntryPath()
    const profile = createTestConfigDir(entry, [])
    const configFile = join(profile, '.halo', 'config.json')
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    const now = new Date().toISOString()
    config.api = { provider: 'openai', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'gpt-4o' }
    config.aiSources = { version: 2, currentId: 'acceptance-terminal', sources: [{ id: 'acceptance-terminal', name: 'Local terminal model', authType: 'api-key', ...config.api, availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }], createdAt: now, updatedAt: now }] }
    config.agent = { ...config.agent, sdkEngine: 'halo', configDirMode: 'custom', customConfigDir: join(profile, 'sdk-state'), maxTurns: 16 }
    config.imChannels = { instances: [] }
    config.notificationChannels = {}
    writeFileSync(configFile, JSON.stringify(config, null, 2))
    const programs: OwnedPtyProgram[] = []
    const sessionIds = new Set<string>()
    const failures: unknown[] = []
    let owned: OwnedManagementApp | undefined
    let window: Page | undefined
    let events: TerminalLifecycleEvent[] = []
    try {
      const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
      const app = await launchElectronApp(entry, profile, { bootstrapDirectory: project })
      owned = trackManagementApp(app)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await window.setViewportSize({ width: 1600, height: 1000 })
      await window.evaluate(() => {
        const state = globalThis as unknown as ProbeWindow
        const probe: ProbeWindow['acceptanceProbe'] = { turns: [], errors: [], terminals: [] }
        state.acceptanceProbe = probe
        state.halo.onAgentTurnStart(value => { const turn = value as { conversationId: string; spaceId: string }; probe.turns.push({ ...turn, completed: false }) })
        state.halo.onAgentComplete(value => { const { conversationId } = value as { conversationId: string }; const turn = probe.turns.findLast(turn => turn.conversationId === conversationId && !turn.completed); if (turn) turn.completed = true })
        state.halo.onAgentError(value => probe.errors.push(value))
        state.halo.onTerminalLifecycle(value => probe.terminals.push(value as TerminalLifecycleEvent))
      })
      expect(await window.evaluate(() => (globalThis as unknown as ProbeWindow).halo.getEngineAvailability())).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
      await use({ app, profile, window, programs, sessionIds, program(label) { const program = ownedPtyProgram(profile, label); programs.push(program); return program } })
      expect(model.errors).toEqual([])
    } catch (error) { failures.push(error) }
    finally {
      const beforeCleanup = programs.map(program => program.observation())
      if (window && !window.isClosed()) {
        try {
          events = await terminalEvents(window)
          await window.screenshot({ path: info.outputPath('terminal-final-window.png'), timeout: 5000 })
        } catch (error) { failures.push(error) }
      }
      for (const program of programs) {
        try { await program.stopProgram() }
        catch (error) { if (program.observation().process.state !== 'exited') failures.push(error) }
      }
      if (window && !window.isClosed()) {
        try {
          for (const session of await terminals(window)) sessionIds.add(session.id)
          for (const sessionId of sessionIds) {
            const result = await window.evaluate(id => (globalThis as unknown as ProbeWindow).halo.killTerminal({ sessionId: id }), sessionId)
            if (!result.success && result.code !== 'TERMINAL_NOT_FOUND') throw new Error('The actual terminal registry refused cleanup of an owned session')
          }
        } catch (error) { failures.push(error) }
      }
      if (owned) {
        try { await closeManagementApp(owned, 15000, 'terminal-teardown') } catch (error) { failures.push(error) }
      }
      try {
        await expect.poll(() => programs.every(program => program.confirmedExited()), { timeout: 10000, message: 'Every owned program and PTY shell must actually exit before profile cleanup' }).toBe(true)
      } catch (error) { failures.push(error) }
      const observations = programs.map(program => program.observation())
      const identifiedSessions = new Set(observations.flatMap(value => value.receipt && value.sessionId ? [value.sessionId] : []))
      const allExited = observations.every(value => !value.sessionId && !value.issued || value.process.state === 'exited' && value.shell.state === 'exited')
      const known = [...sessionIds].every(id => identifiedSessions.has(id))
      try {
        await info.attach('terminal-process-lifecycle', { body: JSON.stringify({ events, beforeCleanup, observations, allExited, known }, null, 2), contentType: 'application/json' })
        await info.attach('scripted-model-exchanges', { body: JSON.stringify({ exchanges: model.exchanges, errors: model.errors }, null, 2), contentType: 'application/json' })
        const log = join(profile, '.halo', 'logs', 'main.log')
        if (existsSync(log)) await info.attach('application-main-log', { body: readFileSync(log).subarray(-1000000), contentType: 'text/plain' })
      } catch (error) { failures.push(error) }
      if (owned?.closed && allExited && known) {
        try { cleanupTestConfigDir(profile) } catch (error) { failures.push(error) }
      }
      else {
        console.error('[AcceptanceTerminal] Retained the owned profile because process exit is unconfirmed', { profile, applicationClosed: owned?.closed ?? false, allExited, known })
        failures.push(new Error('Owned terminal or application exit is unknown; profile retained'))
      }
    }
    if (failures.length) {
      try {
        await info.attach('terminal-failures', { body: JSON.stringify(failures.map(error => error instanceof Error ? { message: error.message, stack: error.stack, causes: error instanceof AggregateError ? error.errors.map(cause => cause instanceof Error ? cause.stack : String(cause)) : undefined } : { message: String(error) }), null, 2), contentType: 'application/json' })
      } catch (error) { failures.push(error) }
      throw new AggregateError(failures, 'Terminal acceptance or its owned-resource cleanup failed')
    }
  },
  window: async ({ terminalApp }, use) => { await use(terminalApp.window) },
})

export function terminalAcceptance(caseId: string, mode: 'scripted' | 'none' = 'scripted') {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode, variant: {} }) } }
}

export async function terminals(page: Page): Promise<TerminalInfo[]> {
  const response = await page.evaluate(() => (window as unknown as ProbeWindow).halo.listTerminals())
  expect(response.success).toBe(true)
  return response.data as TerminalInfo[]
}

export async function terminalEvents(page: Page) {
  return page.evaluate(() => (window as unknown as ProbeWindow).acceptanceProbe.terminals)
}

export async function replay(page: Page, sessionId: string) {
  const response = await page.evaluate(sessionId => (window as unknown as ProbeWindow).halo.getTerminalReplay({ sessionId }), sessionId)
  expect(response.success).toBe(true)
  return response.data as { info: TerminalInfo; data: string }
}

export function terminalTab(page: Page, title: string) {
  return page.locator('.canvas-tab').filter({ has: page.locator('.canvas-tab-title').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
}

export async function openOwnedTerminal(app: TerminalSessionApp, label: string, spaceId: string) {
  const page = app.window
  const previous = new Set((await terminals(page)).map(session => session.id))
  await openFromHeaderMenu(page, 'Open terminal')
  await expect.poll(async () => (await terminals(page)).filter(session => !previous.has(session.id)).length).toBe(1)
  const info = (await terminals(page)).find(session => !previous.has(session.id))!
  app.sessionIds.add(info.id)
  expect(info).toMatchObject({ spaceId, state: 'running', owner: 'user', aiTouched: false })
  return startOwnedTerminalProgram(app, label, info)
}

export async function startOwnedTerminalProgram(app: TerminalSessionApp, label: string, info: TerminalInfo) {
  const page = app.window
  app.sessionIds.add(info.id)
  await expect(terminalTab(page, info.title)).toHaveClass(/\bactive\b/)
  const program = app.program(label)
  program.bind(info.id)
  await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1)
  await expect(page.locator('.xterm-rows')).toBeVisible()
  await expect.poll(async () => (await page.locator('.xterm-rows').innerText()).trim()).not.toBe('')
  await page.locator('.xterm-helper-textarea').pressSequentially(program.command)
  program.markIssued()
  await page.locator('.xterm-helper-textarea').press('Enter')
  await expect.poll(program.receipt, { timeout: 15000 }).toBeTruthy()
  await expect(page.locator('.xterm-rows')).toContainText(program.ready)
  return { info, program }
}

export async function typeTerminalInput(page: Page, program: OwnedPtyProgram, input: string) {
  const sequence = program.inputs().length + 1
  await expect(page.locator('.xterm-rows')).toBeVisible()
  await page.locator('.xterm-helper-textarea').pressSequentially(input)
  await page.locator('.xterm-helper-textarea').press('Enter')
  await expect.poll(() => program.inputs().length).toBe(sequence)
  await expect(page.locator('.xterm-rows')).toContainText(program.ack(sequence, input))
  expect(program.inputs().at(-1)).toMatchObject({ sequence, input, pid: program.receipt()!.pid, cwd: program.receipt()!.cwd })
}

export { expect } from '@playwright/test'
