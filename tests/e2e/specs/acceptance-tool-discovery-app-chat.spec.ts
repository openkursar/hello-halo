import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { Thought } from '../../../src/shared/types/transcript'
import { test, expect, OWNER_ID, GUEST_ID, imTranscript, showImConversation, waitForGuestChannel, waitForImIdle } from '../fixtures/acceptance-guest'
import { startAcceptanceMcp } from '../fixtures/acceptance-mcp'
import { createToolDiscoveryScenario } from '../fixtures/acceptance-tool-discovery'

test.setTimeout(150000)

for (const entry of ['digital-human', 'im-owner', 'im-guest'] as const) {
  test(`${entry} discovers an MCP tool, restores its instructions and cannot use it after disablement`, {
    annotation: { type: 'acceptance', description: JSON.stringify({
      caseId: 'capabilities.tool-discovery.application', evidence: 'app-e2e', mode: 'scripted', variant: { entry },
    }) },
  }, async ({ acceptanceApp, guestApp, wecom, model, window }, info) => {
    const service = await startAcceptanceMcp()
    let page = window
    const senderId = entry === 'im-owner' ? OWNER_ID : GUEST_ID
    const scenario = createToolDiscoveryScenario(entry)
    const { requests, results, issues } = scenario
    let phase = 'discover'
    let ownConversationId: string | undefined
    const historyForTurn = async () => {
      if (!ownConversationId) return imTranscript(page, guestApp, senderId)
      const history = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), {
        appId: guestApp.appId, spaceId: guestApp.spaceId, conversationId: ownConversationId,
      })
      expect(history.success).toBe(true)
      return { conversationId: ownConversationId, messages: history.data!.messages }
    }
    try {
      const installed = await page.evaluate(({ spaceId, url }) => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({
        spaceId,
        spec: { spec_version: '1', type: 'mcp', name: 'Channel receipt service', version: '1.0.0', author: 'Acceptance',
          description: 'Look up a supplied receipt through the isolated channel service.',
          mcp_server: { transport: 'streamable-http', command: url } },
      }), { spaceId: guestApp.spaceId, url: service.url })
      expect(installed.success).toBe(true)
      const appId = (installed.data as { appId: string }).appId
      const loaded = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id), appId)
      expect(loaded.success).toBe(true)
      const connection = loaded.data as InstalledApp
      if (entry === 'digital-human') {
        const created = await page.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appSessionCreate({ appId }), guestApp.appId)
        expect(created.success).toBe(true)
        ownConversationId = created.data!.conversationId
      }
      if (entry === 'im-guest') {
        const saved = await page.evaluate(({ instanceId, server }) => (globalThis as unknown as { halo: HaloAPI }).halo.imChannelsUpdateInstance(instanceId, {
          guestPolicy: { allowedTools: [], allowedUserMcp: [server] },
        }), { instanceId: guestApp.instanceId, server: connection.specId })
        expect(saved.success).toBe(true)
        await waitForGuestChannel(page, guestApp, wecom)
      }
      model.respond(scenario.respond)
      for (const next of ['discover', 'continue', 'restored', 'disabled']) {
        phase = next
        scenario.start(phase)
        if (phase === 'restored') {
          page = await acceptanceApp.restart()
          await waitForGuestChannel(page, guestApp, wecom)
        }
        if (phase === 'disabled') {
          const saved = await page.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({
            appId, overrides: { disabledTools: ['echo_acceptance'] },
          }), appId)
          expect(saved.success).toBe(true)
        }
        const question = `Use the receipt service for ${entry}-${phase}.`
        const answer = `Channel operation recorded: ${entry}-${phase}.`
        if (ownConversationId) {
          const sent = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSend(input), {
            appId: guestApp.appId, spaceId: guestApp.spaceId, conversationId: ownConversationId, message: question,
          })
          expect(sent.success).toBe(true)
          await expect.poll(async () => (await historyForTurn()).messages.some(message => message.role === 'assistant' && message.content.includes(answer)), { timeout: 45000 }).toBe(true)
          await expect.poll(async () => {
            const state = await page.evaluate(({ appId, conversationId }) => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(appId, conversationId), {
              appId: guestApp.appId, conversationId: ownConversationId!,
            })
            expect(state.success).toBe(true)
            return (state.data as { isActive: boolean }).isActive
          }).toBe(false)
        } else {
          const sent = await wecom.sendText({ senderId, senderName: `Acceptance ${entry}`, chatId: senderId, chatType: 'direct', text: question })
          await wecom.waitForReply({ requestId: sent.requestId, contains: answer })
          await waitForImIdle(page, guestApp, senderId)
        }
        expect(issues).toEqual([])
        const turn = requests.get(phase)!
        expect(turn).toHaveLength(phase === 'discover' ? 3 : 2)
        expect(turn[0].tools.some(name => name.endsWith('__echo_acceptance'))).toBe(false)
        if (phase === 'discover') {
          expect(turn[0].tools).toEqual(expect.arrayContaining(['ToolSearch', 'CallTool']))
          expect(turn[0].text).not.toContain('Return the supplied acceptance value.')
          expect(turn[1].text).toContain('Return the supplied acceptance value.')
          for (const request of turn) expect(request.body.tools).toEqual(turn[0].body.tools)
        } else if (phase !== 'disabled') {
          expect(turn[0].text).toContain('Return the supplied acceptance value.')
          expect(turn[0].text).toContain('input_schema')
        }
        const history = await historyForTurn()
        expect(history.messages.some(message => message.role === 'user' && message.content.includes(question))).toBe(true)
        const assistant = history.messages.findLast(message => message.role === 'assistant' && message.content.includes(answer))!
        expect(assistant).toBeDefined()
        if (phase === 'disabled') {
          expect(results.get(phase)).toMatch(/unavailable|not available|not found|not registered|not discovered|disabled|search/i)
          expect(results.get(phase)).not.toContain(`Service receipt: ${entry}-${phase}`)
        } else {
          expect(results.get(phase)).toContain(`Service receipt: ${entry}-${phase}`)
          const thoughts = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatMessageThoughts(input), {
            appId: guestApp.appId, spaceId: guestApp.spaceId, conversationId: history.conversationId, messageId: assistant.id,
          })
          expect(thoughts.success).toBe(true)
          const tools = (thoughts.data as Thought[]).filter(thought => thought.type === 'tool_use')
          expect(tools.filter(tool => tool.toolName === scenario.target)).toHaveLength(1)
          expect(tools.some(tool => tool.toolName === 'CallTool')).toBe(false)
        }
        if (!ownConversationId) await showImConversation(page, guestApp, senderId, answer)
      }
      expect(service.calls).toEqual(['discover', 'continue', 'restored'].map(phase => ({ value: `${entry}-${phase}`, failed: false })))
      await info.attach('channel-tool-discovery', { body: JSON.stringify({ entry, target: scenario.target, requests: [...requests], results: [...results], calls: service.calls }, null, 2), contentType: 'application/json' })
    } finally { await service.close() }
  })
}
