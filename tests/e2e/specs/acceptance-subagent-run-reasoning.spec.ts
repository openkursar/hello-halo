import { assertRequestedReasoning, reasoningSource, reasoningVariants } from '../fixtures/acceptance-subagent-reasoning'
import type { HaloAPI } from '../../../src/preload'
import { triggerAssignmentWebhook } from '../fixtures/acceptance-subagent-run'
import { test, expect, acceptance, openAutomation, startAutomation, readAutomationRuns, waitForAutomationResult } from '../fixtures/acceptance-automation'
import { initialUserInput, modelTool, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) {
  for (const reasoning of reasoningVariants(sdkEngine))
  for (const trigger of ['manual', 'schedule', 'webhook'] as const) test.describe(`${trigger} run ${reasoning} reasoning on ${sdkEngine}`, () => {
    test.use({ sdkEngine, automationInterval: trigger === 'schedule' ? '20s' : '24h', aiSource: async ({ model }, use) => {
      await use(reasoningSource(model.url, reasoning))
    } })
    test('a run collaborator preserves its parent effective default reasoning', acceptance('models.subagent-profiles.baseline-reasoning', { engine: sdkEngine, entry: `${trigger}-run`, reasoning }), async ({ model, automation, window }, info) => {
      test.setTimeout(180000)
      const parentRequests: ModelRequest[] = []
      const childRequests: ModelRequest[] = []
      const errors: string[] = []
      const assignment = 'RUN_REASONING_CHILD: Verify gamma and return gamma-confirmed.'
      let handle: string | undefined
      const call = (request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply => {
        const advertised = request.tools.find(tool => tool === name || tool.endsWith(`__${name}`))
        const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
        if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === `discover-${name}`))) return { tools: [modelTool(request, name, input, id)] }
        if (request.tools.includes('ToolSearch')) return { tools: [modelTool(request, 'ToolSearch', { query: `select:mcp__halo-team__${name}`, max_results: 1 }, `discover-${name}`)] }
        errors.push(`Missing run collaboration tool ${name}`)
        return { text: 'The run collaboration tool is unavailable.' }
      }
      model.respond(request => {
        if (initialUserInput(request).includes(assignment)) {
          childRequests.push(request)
          return { text: 'gamma-confirmed' }
        }
        parentRequests.push(request)
        const spawn = request.toolResults.find(result => result.id === 'run-reasoning-spawn')
        if (!spawn) return call(request, 'spawn_agent', { name: 'Gamma checker', prompt: assignment }, 'run-reasoning-spawn')
        try { handle = collaboratorReceipt(spawn).handle } catch (error) { errors.push(String(error)) }
        if (!request.text.includes('gamma-confirmed')) return { text: 'The gamma checker is preparing.' }
        if (!request.toolResults.some(result => result.id === 'run-reasoning-report')) return call(request, 'report_to_user', { type: 'run_complete', message: 'gamma-confirmed' }, 'run-reasoning-report')
        return { text: 'The gamma run is complete.' }
      })
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
      expect(handle).toBeTruthy()
      expect(errors).toEqual([])
      expect(parentRequests.length).toBeGreaterThan(0)
      expect(childRequests.length).toBeGreaterThan(0)
      const wire = (body: Record<string, unknown>) => ({ model: body.model, reasoning_effort: body.reasoning_effort, reasoning: body.reasoning, thinking: body.thinking, output_config: body.output_config })
      const parent = wire(parentRequests[0].body)
      assertRequestedReasoning(sdkEngine, reasoning, parentRequests[0].body, `${trigger}-run`)
      assertRequestedReasoning(sdkEngine, reasoning, childRequests[0].body, `${trigger}-run`)
      for (const request of childRequests) expect(wire(request.body)).toEqual(parent)
      const snapshots = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId: id }), automation.appId)
      expect(snapshots.success).toBe(true)
      await info.attach('run-parent-child-reasoning', { body: JSON.stringify({ engine: sdkEngine, trigger, runId: run.runId, parent, children: childRequests.map(request => wire(request.body)) }, null, 2), contentType: 'application/json' })
    })
  })
}
