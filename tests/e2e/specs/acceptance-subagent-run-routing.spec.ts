import { test, expect, acceptance, openAutomation, startAutomation, readAutomationRuns, waitForAutomationResult } from '../fixtures/acceptance-automation'
import { startAcceptanceModel } from '../fixtures/acceptance-model'
import { configureRoutingTarget, assignmentRoutingScript } from '../fixtures/acceptance-subagent-routing'
import { triggerAssignmentWebhook } from '../fixtures/acceptance-subagent-run'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) for (const trigger of ['manual', 'schedule', 'webhook'] as const) test.describe(`${trigger} assignment routing on ${sdkEngine}`, () => {
  test.use({ sdkEngine, automationInterval: trigger === 'schedule' ? '20s' : '24h' })
  test('a run creates work on the configured endpoint and retains its reviewed report', acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: `${trigger}-run`, choice: 'profile' }), async ({ model, automation, window }, info) => {
    test.setTimeout(180000)
    const endpoint = await startAcceptanceModel()
    const script = assignmentRoutingScript({ run: true })
    model.respond(script.parent)
    endpoint.respond(script.child)
    try {
      await configureRoutingTarget(window, endpoint)
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
      expect(script.handle).toBeTruthy()
      expect(script.errors).toEqual([])
      expect(script.childRequests.length).toBeGreaterThan(0)
      expect(endpoint.errors).toEqual([])
      for (const request of script.childRequests) expect(request.body.model).toBe('gpt-4o')
    } finally {
      await info.attach('assigned-run-provider-exchanges', { body: JSON.stringify(endpoint.exchanges, null, 2), contentType: 'application/json' })
      await endpoint.close()
    }
  })
})
