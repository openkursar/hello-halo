import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import {
  chooseEngine, configuredEngine, engineReport, freshEngineConversation, readEngineConversation,
  type SelectionEngine,
} from '../fixtures/acceptance-engine-selection'
import { openManagedConversation } from '../fixtures/acceptance-management'

test.setTimeout(240000)

test('a Halo to Claude Code to Halo choice takes effect only after owned process restart and runs new work on the requested engine', acceptance('models.engines.global-selection'), async ({ acceptanceApp, model, window }, info) => {
  let phase = 'initial-halo'
  const observations: Array<Record<string, unknown>> = []
  const requests: Array<{ phase: string; sequence: number; question: string; protocol: string }> = []
  model.respond(request => {
    requests.push({ phase, sequence: request.sequence, question: request.lastUserText, protocol: request.protocol })
    return { text: `Engine selection reply ${phase}.` }
  })
  const initial = await engineReport(window)
  expect(initial).toMatchObject({ activeEngine: 'halo', degradedFrom: null })
  for (const engineId of ['halo', 'anthropic']) {
    expect(initial.engines.find(engine => engine.engineId === engineId)).toMatchObject({ available: true })
  }
  expect(configuredEngine(acceptanceApp.profile)).toBe('halo')

  async function runTurn(page: Page, conversationId: string, active: SelectionEngine) {
    const before = await readEngineConversation(page, conversationId)
    const question = `Check this engine selection ${phase} ${randomUUID().slice(0, 8)}.`
    const count = model.exchanges.length
    const turn = await sendAcceptanceMessage(page, question)
    expect(turn).toMatchObject({ spaceId: 'halo-temp', conversationId })
    await expect(page.locator('.message-assistant').last()).toContainText(`Engine selection reply ${phase}.`, { timeout: 45000 })
    await waitForAcceptanceIdle(page, conversationId)
    const report = await engineReport(page)
    expect(report).toMatchObject({ activeEngine: active, degradedFrom: null })
    const stored = await readEngineConversation(page, conversationId)
    expect(stored.engineId).toBe(active)
    expect(stored.messages.slice(0, before.messages.length)).toEqual(before.messages)
    expect(stored.messages.slice(before.messages.length)).toEqual([
      expect.objectContaining({ role: 'user', content: question }),
      expect.objectContaining({ role: 'assistant', content: `Engine selection reply ${phase}.` }),
    ])
    expect(stored.messages.at(-1)?.error).toBeFalsy()
    expect(model.exchanges.length).toBe(count + 1)
    expect(model.exchanges[count].completed).toBe(true)
    expect(model.exchanges[count].request.lastUserText).toContain(question)
    observations.push({ phase, conversationId, configured: configuredEngine(acceptanceApp.profile), report, recordedEngine: stored.engineId, messages: stored.messages.map(({ id, role, content }) => ({ id, role, content })) })
    return stored
  }

  let page = window
  let current: SelectionEngine = 'halo'
  let conversation = await freshEngineConversation(page, current)
  const createdIds = [conversation.id]
  try {
    conversation = await runTurn(page, conversation.id, current)
    for (const target of ['anthropic', 'halo'] as const) {
      const previousApp = acceptanceApp.app
      const child = previousApp.process()
      const before = await engineReport(page)
      expect(before).toMatchObject({ activeEngine: current, degradedFrom: null })
      await chooseEngine(page, acceptanceApp.profile, target)
      expect(acceptanceApp.app).toBe(previousApp)
      expect(await engineReport(page)).toMatchObject({ activeEngine: current, degradedFrom: null })
      expect(configuredEngine(acceptanceApp.profile)).toBe(target)
      phase = `pending-${target}`
      await openManagedConversation(page, conversation.title)
      conversation = await runTurn(page, conversation.id, current)
      const beforeRestart = conversation
      page = await acceptanceApp.restart()
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      expect(acceptanceApp.app).not.toBe(previousApp)
      const after = await engineReport(page)
      expect(after).toMatchObject({ activeEngine: target, degradedFrom: null })
      expect(after.engines.find(engine => engine.engineId === target)).toMatchObject({ available: true })
      expect(configuredEngine(acceptanceApp.profile)).toBe(target)
      expect((await readEngineConversation(page, beforeRestart.id)).messages).toEqual(beforeRestart.messages)
      observations.push({ phase: `restarted-${target}`, previousPid: child.pid, activePid: acceptanceApp.app.process().pid, configured: configuredEngine(acceptanceApp.profile), report: after })
      current = target
      phase = `active-${target}`
      conversation = await freshEngineConversation(page, current)
      createdIds.push(conversation.id)
      conversation = await runTurn(page, conversation.id, current)
    }
    expect(new Set(createdIds).size).toBe(3)
    expect(model.exchanges).toHaveLength(5)
    expect(requests.map(request => request.phase)).toEqual(['initial-halo', 'pending-anthropic', 'active-anthropic', 'pending-halo', 'active-halo'])
  } finally {
    await info.attach('engine-selection-transitions', { body: JSON.stringify({ initial, createdIds, observations, requests }, null, 2), contentType: 'application/json' })
  }
})
