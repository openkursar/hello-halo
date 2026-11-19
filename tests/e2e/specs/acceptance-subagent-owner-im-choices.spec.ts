import { test, expect, OWNER_ID, GROUP_ID, waitForImIdle } from '../fixtures/acceptance-guest'
import { acceptance } from '../fixtures/acceptance-app'
import { prepareOwnerChoice, ownerChoiceScript, assertOwnerChoiceWire, assertOwnerFailure } from '../fixtures/acceptance-subagent-owner-choices'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Owner IM choices on ${sdkEngine}`, () => {
  test.use({ sdkEngine, aiSource: async ({ model }, use) => {
    await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'o3' })
  } })
  for (const choice of ['inherit', 'removed-effort', 'provider-failure'] as const) test(`owner IM reviews ${choice}`, acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'owner-im', choice }), async ({ guestApp, wecom, model, window }, info) => {
    test.setTimeout(180000)
    const endpoint = await prepareOwnerChoice(window, choice)
    const script = ownerChoiceScript(choice)
    model.respond(script.reply)
    try {
      await wecom.sendText({ senderId: OWNER_ID, senderName: 'Owner', chatId: GROUP_ID, chatType: 'group', text: script.marker })
      await wecom.waitForReply({ chatId: GROUP_ID, contains: 'owner-choice-parent-complete', timeoutMs: 120000 })
      await waitForImIdle(window, guestApp, GROUP_ID, 'group')
      assertOwnerChoiceWire(script, choice)
      assertOwnerFailure(endpoint, script)
      expect(wecom.replies.some(reply => reply.text === 'owner-choice-child-complete')).toBe(false)
      expect(model.errors).toEqual([])
      await info.attach('owner-im-choice', { body: JSON.stringify({ parents: script.parents, children: script.children, rejected: endpoint?.requests }, null, 2), contentType: 'application/json' })
    } finally { await endpoint?.close() }
  })
})
