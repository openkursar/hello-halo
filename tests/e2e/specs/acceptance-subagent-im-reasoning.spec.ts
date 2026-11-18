import { assertRequestedReasoning, reasoningSource, reasoningVariants } from '../fixtures/acceptance-subagent-reasoning'
import { test, expect, OWNER_ID, GROUP_ID, waitForImIdle } from '../fixtures/acceptance-guest'
import { acceptance } from '../fixtures/acceptance-app'
import { createImCollaborationScript, question, assignment, started, reviewed } from '../fixtures/acceptance-im-collaboration'
import { initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const)
for (const reasoning of reasoningVariants(sdkEngine)) test.describe(`Owner IM ${reasoning} reasoning on ${sdkEngine}`, () => {
  test.use({ sdkEngine, diagnoseShutdown: true, aiSource: async ({ model }, use) => {
    await use(reasoningSource(model.url, reasoning))
  } })
  test('the owner IM collaborator uses the actual parent default reasoning and reports only through its source', acceptance('models.subagent-profiles.baseline-reasoning', { engine: sdkEngine, entry: 'owner-im', reasoning }), async ({ guestApp, wecom, model, window }, info) => {
    test.setTimeout(180000)
    const script = createImCollaborationScript()
    const children: ModelRequest[] = []
    model.respond(request => {
      if (initialUserInput(request).includes(assignment)) children.push(request)
      return script.reply(request)
    })
    try {
      const sent = await wecom.sendText({ senderId: OWNER_ID, senderName: 'Owner', chatId: GROUP_ID, chatType: 'group', text: question })
      await wecom.waitForReply({ requestId: sent.requestId, contains: started })
      await expect.poll(() => children.length, { timeout: 60000 }).toBeGreaterThan(0)
      const wire = (body: Record<string, unknown>) => ({ model: body.model, reasoning_effort: body.reasoning_effort, reasoning: body.reasoning, thinking: body.thinking, output_config: body.output_config })
      const parent = wire(script.initialRequests[0].body)
      assertRequestedReasoning(sdkEngine, reasoning, script.initialRequests[0].body, 'owner-im')
      assertRequestedReasoning(sdkEngine, reasoning, children[0].body, 'owner-im')
      for (const request of children) expect(wire(request.body)).toEqual(parent)
      script.release()
      await wecom.waitForReply({ chatId: GROUP_ID, contains: reviewed, timeoutMs: 90000 })
      await waitForImIdle(window, guestApp, GROUP_ID, 'group')
      expect(script.errors).toEqual([])
      expect(script.memberStarted).toBe(true)
      expect(script.initialRequests.some(request => request.toolResults.some(result => result.id === 'im-spawn' && !result.error))).toBe(true)
      expect(script.initialRequests.some(request => request.tools.some(name => name.endsWith('list_model_profiles')))).toBe(false)
      await info.attach('owner-im-inherited-reasoning', { body: JSON.stringify({ engine: sdkEngine, parent, children: children.map(request => wire(request.body)) }, null, 2), contentType: 'application/json' })
    } finally { script.release() }
  })
})
