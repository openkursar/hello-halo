import { assertRequestedReasoning, waitForReasoningParentIdle, reasoningVariants, reasoningSource, selectedReasoning } from '../fixtures/acceptance-subagent-reasoning'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance } from '../fixtures/acceptance-automation'
import { createEngineCollaborationScript, engineSourceQuestion, engineSourceAnswer } from '../fixtures/acceptance-engine-collaboration'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) {
  for (const reasoning of reasoningVariants(sdkEngine)) test.describe(`Digital-human ${reasoning} reasoning inheritance on ${sdkEngine}`, () => {
    test.use({ sdkEngine, aiSource: async ({ model }, use) => {
      await use(reasoningSource(model.url, ['max', 'budget', 'adaptive'].includes(reasoning) ? reasoning : 'provider-default'))
    } })
    {
      const requestedEffort = selectedReasoning(reasoning)
      test(`new owner chat passes effective ${reasoning} to its collaborator`, acceptance('models.subagent-profiles.baseline-reasoning', { engine: sdkEngine, entry: 'digital-human', reasoning }), async ({ model, automation, window }, info) => {
        test.setTimeout(180000)
        const script = createEngineCollaborationScript()
        model.respond(script.reply)
        const session = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appSessionCreate({ appId }), automation.appId)
        expect(session.success).toBe(true)
        const conversationId = session.data!.conversationId
        const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend(input), {
          appId: automation.appId, spaceId: 'halo-temp', conversationId, message: engineSourceQuestion, reasoningEffort: requestedEffort,
        })
        expect(sent.success, sent.error).toBe(true)
        await expect.poll(async () => {
          const transcript = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: automation.appId, spaceId: 'halo-temp', conversationId })
          return transcript.data?.messages.some(message => message.content.includes(engineSourceAnswer)) ?? false
        }, { timeout: 120000 }).toBe(true)
        expect(script.errors).toEqual([])
        expect(script.memberRequests.length).toBeGreaterThan(0)
        expect(script.sourceRequests.length).toBeGreaterThan(0)
        const wire = (body: Record<string, unknown>) => ({ model: body.model, reasoning_effort: body.reasoning_effort, reasoning: body.reasoning, thinking: body.thinking, output_config: body.output_config })
        const parent = wire(script.sourceRequests[0].body)
        assertRequestedReasoning(sdkEngine, reasoning, script.sourceRequests[0].body, 'digital-human')
        assertRequestedReasoning(sdkEngine, reasoning, script.memberRequests[0].body, 'digital-human')
        expect(script.created?.handle).toBeTruthy()
        expect(script.followedUp).toBe(true)
        await waitForReasoningParentIdle(window, conversationId)
        for (const request of script.memberRequests) expect(wire(request.body)).toEqual(parent)
        expect(script.sourceRequests.some(request => request.tools.some(name => name.endsWith('list_model_profiles')))).toBe(false)
        await info.attach('digital-human-parent-child-reasoning', { body: JSON.stringify({ requestedEngine: sdkEngine, requestedReasoning: reasoning, parent, children: script.memberRequests.map(request => wire(request.body)) }, null, 2), contentType: 'application/json' })
      })
    }
  })
}
