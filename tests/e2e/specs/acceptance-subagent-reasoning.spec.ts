import { assertRequestedReasoning, reasoningVariants, reasoningSource, selectedReasoning } from '../fixtures/acceptance-subagent-reasoning'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createEngineCollaborationScript, engineSourceQuestion, engineSourceAnswer } from '../fixtures/acceptance-engine-collaboration'
import { storedAssignmentConfig } from '../fixtures/acceptance-subagent-models'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) {
  for (const reasoning of reasoningVariants(sdkEngine)) test.describe(`Unconfigured ${reasoning} model assignments on ${sdkEngine}`, () => {
    test.use({ sdkEngine, aiSource: async ({ model }, use) => {
      await use(reasoningSource(model.url, ['max', 'budget', 'adaptive'].includes(reasoning) ? reasoning : 'provider-default'))
    } })
    {
      const requestedEffort = selectedReasoning(reasoning)
      test(`space collaborators preserve actual ${reasoning} reasoning on the wire`, acceptance('models.subagent-profiles.baseline-reasoning', { engine: sdkEngine, entry: 'space', reasoning }), async ({ window, model, acceptanceApp }, info) => {
        test.setTimeout(180000)
        const script = createEngineCollaborationScript()
        model.respond(script.reply)
        const created = await window.evaluate(effort => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Reasoning inheritance', effort), requestedEffort)
        expect(created.success).toBe(true)
        const conversationId = (created.data as { id: string }).id
        const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage(input), {
          spaceId: 'halo-temp', conversationId, message: engineSourceQuestion, reasoningEffort: requestedEffort,
        })
        expect(sent.success, sent.error).toBe(true)
        await expect.poll(async () => {
          const history = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', id), conversationId)
          return (history.data as { messages: Array<{ content: string }> } | undefined)?.messages.some(message => message.content.includes(engineSourceAnswer)) ?? false
        }, { timeout: 120000 }).toBe(true)
        await waitForAcceptanceIdle(window, conversationId)
        expect(script.errors).toEqual([])
        expect(script.sourceRequests.length).toBeGreaterThan(0)
        expect(script.memberRequests.length).toBeGreaterThan(0)
        const wire = (body: Record<string, unknown>) => ({
          model: body.model, reasoning_effort: body.reasoning_effort,
          reasoning: body.reasoning, thinking: body.thinking,
          output_config: body.output_config,
        })
        const parent = wire(script.sourceRequests[0].body)
        assertRequestedReasoning(sdkEngine, reasoning, script.sourceRequests[0].body, 'space')
        assertRequestedReasoning(sdkEngine, reasoning, script.memberRequests[0].body, 'space')
        expect(script.created?.handle).toBeTruthy()
        expect(script.followedUp).toBe(true)
        for (const child of script.memberRequests) expect(wire(child.body)).toEqual(parent)
        const observedReasoning = parent.reasoning_effort ?? parent.reasoning ?? parent.thinking ?? parent.output_config
        if (reasoning !== 'off') expect(observedReasoning, 'The assertion must observe actual reasoning, not merely two omitted fields').toBeDefined()
        for (const request of [...script.sourceRequests, ...script.memberRequests]) {
          expect(request.tools.some(name => name.endsWith('list_model_profiles'))).toBe(false)
          const spawn = (request.body.tools ?? []).find((tool: Record<string, any>) => String(tool.name ?? tool.function?.name).endsWith('spawn_agent'))
          if (spawn) {
            const schema = spawn.input_schema ?? spawn.function?.parameters
            expect(schema?.properties?.model_profile).toBeUndefined()
            expect(schema?.properties?.reasoning_effort).toBeUndefined()
          }
        }
        expect(storedAssignmentConfig(acceptanceApp.profile).settings).toBeUndefined()
        await info.attach('actual-parent-child-reasoning', { body: JSON.stringify({ requestedEngine: sdkEngine, requestedReasoning: reasoning, parent, children: script.memberRequests.map(request => wire(request.body)) }, null, 2), contentType: 'application/json' })
      })
    }
  })
}
