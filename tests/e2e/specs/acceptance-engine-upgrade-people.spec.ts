import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test, expect, acceptance, sendAcceptanceMessage } from '../fixtures/acceptance-app'
import { seedDigitalHumanChat, type SeededDigitalHumanChat } from '../fixtures/seed-digital-human-chat'
import { navigateToChat, openDigitalHumanConversation } from '../fixtures/helpers'
import { test as automationTest, openAutomation, startAutomation, waitForAutomationResult } from '../fixtures/acceptance-automation'
import { modelTool } from '../fixtures/acceptance-model'

import { assertEngineDiscovery, assertNoCcRecoveryNotice, engineDiscoveryObserver } from '../fixtures/acceptance-engine-upgrade'

test.use({ startupObserver: engineDiscoveryObserver })
automationTest.use({ startupObserver: engineDiscoveryObserver })
test.setTimeout(120000)
automationTest.setTimeout(120000)

function historicalDefault(profile: string) {
  const file = join(profile, '.halo', 'config.json')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  config.agent = { ...config.agent, sdkEngine: 'anthropic', legacySdkEngine: 'anthropic', ccRuntime: { selectedPath: join(profile, 'missing-automatic-cc') } }
  writeFileSync(file, JSON.stringify(config))
}

test('a historical digital human receives its prior chat on Halo', acceptance('models.engines.upgrade-person'), async ({ acceptanceApp, model }, info) => {
  let seeded!: SeededDigitalHumanChat
  let mapFile!: string
  const page = await acceptanceApp.restart(profile => {
    historicalDefault(profile)
    seeded = seedDigitalHumanChat(profile, { name: 'Upgrade recorder', turnCount: 3 })
    mapFile = join(dirname(seeded.transcriptPath), '_session-ids.json')
    writeFileSync(mapFile, JSON.stringify({ chat: { version: 1, engineId: 'anthropic', sessionId: 'missing-historical-native' } }))
  })
  const received: boolean[] = []
  model.respond(request => {
    received.push(request.text.includes(seeded.turns[0].user) && request.text.includes(seeded.turns[2].reply))
    return { text: 'The earlier conversation is retained.' }
  })
  await navigateToChat(page)
  await openDigitalHumanConversation(page, seeded.name, seeded.turns[2].reply.slice(0, 20))
  await expect(page.locator('.message-user').first()).toContainText(seeded.turns[0].user)
  await expect(page.locator('.message-assistant').last()).toContainText(seeded.turns[2].reply)
  await assertNoCcRecoveryNotice(page)
  const turn = await sendAcceptanceMessage(page, 'Continue using my first question and your last answer.')
  expect(turn.conversationId).toBe(seeded.conversationId)
  await expect(page.locator('.message-assistant').last()).toContainText('The earlier conversation is retained.')
  await expect.poll(() => JSON.parse(readFileSync(mapFile, 'utf8')).chat?.engineId).toBe('halo')
  expect(received).toEqual([true])
  await assertEngineDiscovery(acceptanceApp, info)
  await info.attach('person-upgrade-context', { body: JSON.stringify({ received, binding: JSON.parse(readFileSync(mapFile, 'utf8')).chat }), contentType: 'application/json' })
})

automationTest('an independent task uses Halo after an ambiguous historical default', acceptance('models.engines.upgrade-automation'), async ({ automation, model }, info) => {
  const page = await automation.session.restart(historicalDefault)
  model.respond(request => request.toolResults.some(result => result.id === 'upgrade-report')
    ? { text: 'Upgrade task completed.' }
    : { tools: [modelTool(request, 'report_to_user', { type: 'run_complete', message: 'Upgrade task completed.' }, 'upgrade-report')] })
  await openAutomation(page, automation)
  const run = await startAutomation(page, automation.appId)
  await waitForAutomationResult(page, automation.appId, run.runId, 'ok')
  const mapFile = join(automation.session.profile, '.halo', 'temp', '.halo', 'apps', automation.appId, 'runs', '_session-ids.json')
  const bindings = JSON.parse(readFileSync(mapFile, 'utf8'))
  expect(bindings[run.runId]?.engineId).toBe('halo')
  expect(model.exchanges.length).toBeGreaterThan(0)
  await assertEngineDiscovery(automation.session, info)
  await info.attach('automation-upgrade-routing', { body: JSON.stringify({ runId: run.runId, binding: bindings[run.runId] }), contentType: 'application/json' })
})
