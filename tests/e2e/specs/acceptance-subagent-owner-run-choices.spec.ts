import { test, expect, acceptance, openAutomation, startAutomation, readAutomationRuns, waitForAutomationResult } from '../fixtures/acceptance-automation'
import { triggerAssignmentWebhook } from '../fixtures/acceptance-subagent-run'
import { prepareOwnerChoice, ownerChoiceScript, assertOwnerChoiceWire, assertOwnerFailure } from '../fixtures/acceptance-subagent-owner-choices'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) for (const trigger of ['manual', 'schedule', 'webhook'] as const) test.describe(`${trigger} owner choices on ${sdkEngine}`, () => {
  test.use({ sdkEngine, automationInterval: trigger === 'schedule' ? '20s' : '24h', aiSource: async ({ model }, use) => {
    await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'o3' })
  } })
  for (const choice of ['inherit', 'effort-only', 'provider-failure'] as const) test(`a real ${trigger} run reviews ${choice}`, acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: `${trigger}-run`, choice }), async ({ model, automation, window }, info) => {
    test.setTimeout(180000)
    const endpoint = await prepareOwnerChoice(window, choice)
    const script = ownerChoiceScript(choice, { run: true })
    model.respond(script.reply)
    try {
      await openAutomation(window, automation)
      let run: Awaited<ReturnType<typeof startAutomation>>
      if (trigger === 'manual') run = await startAutomation(window, automation.appId)
      else {
        if (trigger === 'webhook') await triggerAssignmentWebhook(window, automation.session, automation.appId)
        await expect.poll(async () => (await readAutomationRuns(window, automation.appId)).length, { timeout: 45000 }).toBe(1)
        run = (await readAutomationRuns(window, automation.appId))[0]
        if (trigger === 'schedule') await window.getByRole('button', { name: 'Pause automatic tasks', exact: true }).click()
      }
      expect(run.triggerType).toBe(trigger === 'webhook' ? 'event' : trigger)
      await waitForAutomationResult(window, automation.appId, run.runId, 'ok')
      assertOwnerChoiceWire(script, choice)
      assertOwnerFailure(endpoint, script)
      expect(model.errors).toEqual([])
      await info.attach('owner-run-choice', { body: JSON.stringify({ parents: script.parents, children: script.children, rejected: endpoint?.requests }, null, 2), contentType: 'application/json' })
    } finally { await endpoint?.close() }
  })
})
