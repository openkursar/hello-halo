import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createEngineCollaborationScript, engineSourceQuestion, engineSourceAnswer } from '../fixtures/acceptance-engine-collaboration'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Unspecified upstream reasoning on ${sdkEngine}`, () => {
  test.use({ sdkEngine })
  test('a child does not acquire engine defaults when its parent sends no reasoning control', acceptance('models.subagent-profiles.baseline-reasoning', { engine: sdkEngine, entry: 'space', reasoning: 'off' }), async ({ window, model }, info) => {
    test.setTimeout(180000)
    const script = createEngineCollaborationScript()
    model.respond(script.reply)
    const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Unspecified upstream reasoning', 'off'))
    expect(created.success).toBe(true)
    const conversationId = (created.data as { id: string }).id
    const sent = await window.evaluate(({ conversationId, message }) => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage({ spaceId: 'halo-temp', conversationId, message, reasoningEffort: 'off' }), { conversationId, message: engineSourceQuestion })
    expect(sent.success, sent.error).toBe(true)
    await expect.poll(async () => {
      const result = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', id), conversationId)
      return (result.data as { messages: Array<{ content: string }> }).messages.some(message => message.content.includes(engineSourceAnswer))
    }, { timeout: 120000 }).toBe(true)
    await waitForAcceptanceIdle(window, conversationId)
    expect(script.created?.handle).toBeTruthy()
    expect(script.followedUp).toBe(true)
    expect(script.errors).toEqual([])
    expect(script.sourceRequests.length).toBeGreaterThan(0)
    expect(script.memberRequests.length).toBeGreaterThan(0)
    for (const request of [...script.sourceRequests, ...script.memberRequests]) {
      expect(request.body.model).toBe('gpt-4o')
      expect(request.body.reasoning_effort).toBeUndefined()
      expect(request.body.reasoning).toBeUndefined()
      expect(request.body.thinking).toBeUndefined()
      expect(request.body.output_config?.effort).toBeUndefined()
      expect(request.tools.some(name => name.endsWith('list_model_profiles'))).toBe(false)
    }
    await info.attach('unspecified-parent-child-wire', { body: JSON.stringify({ parents: script.sourceRequests.map(request => request.body), children: script.memberRequests.map(request => request.body) }, null, 2), contentType: 'application/json' })
  })
})
