import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance } from '../fixtures/acceptance-automation'
import { prepareOwnerChoice, ownerChoiceScript, assertOwnerChoiceWire, assertOwnerFailure, waitForOwnerChoiceIdle } from '../fixtures/acceptance-subagent-owner-choices'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Owner choices on ${sdkEngine}`, () => {
  test.use({ sdkEngine, aiSource: async ({ model }, use) => {
    await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'o3' })
  } })
  for (const entry of ['space', 'digital-human'] as const) for (const choice of ['inherit', 'removed-effort', 'provider-failure'] as const) {
    test(`${entry} applies ${choice} without selecting an available profile`, acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry, choice }), async ({ window, model, automation }, info) => {
      test.setTimeout(180000)
      const endpoint = await prepareOwnerChoice(window, choice)
      try {
      const script = ownerChoiceScript(choice)
      model.respond(script.reply)
      const availability = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
      expect(availability).toMatchObject({ success: true, data: { activeEngine: sdkEngine, degradedFrom: null } })
      let conversationId: string
      if (entry === 'space') {
        const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Owner choice verification', 'high'))
        expect(created.success, created.error).toBe(true)
        conversationId = (created.data as { id: string }).id
        const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage(input), {
          spaceId: 'halo-temp', conversationId, message: script.marker, reasoningEffort: 'high' as const,
        })
        expect(sent.success, sent.error).toBe(true)
      } else {
        const created = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appSessionCreate({ appId }), automation.appId)
        expect(created.success, created.error).toBe(true)
        conversationId = created.data!.conversationId
        const sent = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend(input), {
          appId: automation.appId, spaceId: 'halo-temp', conversationId, message: script.marker,
        })
        expect(sent.success, sent.error).toBe(true)
      }
      await expect.poll(() => script.parents.some(request => request.toolResults.some(result => result.id === 'owner-choice-spawn') && (choice === 'provider-failure' ? script.reviewedFailure : choice === 'removed-effort' ? script.reviewedRefusal : request.text.includes('owner-choice-child-complete'))), { timeout: 120000 }).toBe(true)
      if (entry === 'space') {
        await waitForOwnerChoiceIdle(window, conversationId, script, choice)
        const history = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation('halo-temp', id), conversationId)
        expect((history.data as { messages: Array<{ content: string }> }).messages.some(message => message.content.includes('owner-choice-parent-complete'))).toBe(true)
      } else {
        await expect.poll(async () => {
          const history = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: automation.appId, spaceId: 'halo-temp', conversationId })
          return history.data?.messages.some(message => message.role === 'assistant' && message.content.includes('owner-choice-parent-complete')) ?? false
        }, { timeout: 120000 }).toBe(true)
      }
      await waitForOwnerChoiceIdle(window, conversationId, script, choice)
      assertOwnerChoiceWire(script, choice)
      assertOwnerFailure(endpoint, script)
      expect(model.errors).toEqual([])
      await info.attach('owner-choice-wire', { body: JSON.stringify({ engine: sdkEngine, entry, choice, parents: script.parents, children: script.children }, null, 2), contentType: 'application/json' })
      } finally { await endpoint?.close() }
    })
  }
})
