import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage } from '../fixtures/acceptance-app'
import { test as runTest, openAutomation, startAutomation } from '../fixtures/acceptance-automation'
import { createModelGate, startAcceptanceModel, initialUserInput } from '../fixtures/acceptance-model'
import { configureRoutingTarget, assignmentRoutingScript } from '../fixtures/acceptance-subagent-routing'
import { navigateToChat } from '../fixtures/helpers'
import { subagentEffects } from '../fixtures/acceptance-subagent-effects'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) {
  test.describe(`Assigned child cancellation on ${sdkEngine}`, () => {
    test.use({ sdkEngine })
    test('stopping an assigned child stream cannot restart it after its endpoint releases', acceptance('models.subagent-profiles.stop', { boundary: 'child-stream', engine: sdkEngine }), async ({ window, model, acceptanceApp }, info) => {
      test.setTimeout(180000)
      const endpoint = await startAcceptanceModel()
      const gate = createModelGate()
      const script = assignmentRoutingScript()
      model.respond(request => initialUserInput(request).includes('UNRELATED_CANCELLATION_SESSION:') ? { text: 'The unrelated conversation completed.' } : script.parent(request))
      endpoint.respond(request => {
        script.child(request)
        return { text: 'Assigned verification is running.', hold: gate.promise }
      })
      try {
        await configureRoutingTarget(window, endpoint)
        await navigateToChat(window)
        const parent = await sendAcceptanceMessage(window, 'Delegate the verification to Verifier.')
        await expect.poll(() => script.handle, { timeout: 90000 }).toBeTruthy()
        await expect.poll(() => script.childRequests.length, { timeout: 90000 }).toBeGreaterThan(0)
        const before = subagentEffects(acceptanceApp.profile)
        const stopped = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appChatStop(id), script.handle!)
        expect(stopped.success, stopped.error).toBe(true)
        await expect.poll(() => endpoint.exchanges.every(exchange => exchange.cancelled), { timeout: 30000 }).toBe(true)
        const requestCount = script.childRequests.length
        gate.release()
        const created = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.createConversation('halo-temp', 'Unrelated cancellation control'))
        expect(created.success, created.error).toBe(true)
        const conversationId = (created.data as { id: string }).id
        const sent = await window.evaluate(conversationId => (globalThis as unknown as { halo: HaloAPI }).halo.sendMessage({ spaceId: 'halo-temp', conversationId, message: 'UNRELATED_CANCELLATION_SESSION: Continue normally.' }), conversationId)
        expect(sent.success, sent.error).toBe(true)
        await expect.poll(() => model.exchanges.some(exchange => exchange.request.text.includes('UNRELATED_CANCELLATION_SESSION:') && exchange.completed), { timeout: 45000 }).toBe(true)
        await expect.poll(() => window.evaluate(async ({ conversationId, handle }) => {
          const api = (globalThis as unknown as { halo: HaloAPI }).halo
          const session = await api.getSessionState(conversationId)
          if (!session.success) throw new Error('Could not inspect the unrelated conversation')
          const errors = (globalThis as unknown as { acceptanceProbe: { errors: Array<{ conversationId: string; error: string; errorType?: string }> } }).acceptanceProbe.errors
          return {
            active: (session.data as { isActive: boolean }).isActive,
            unexpected: errors.filter(error => !error.conversationId.startsWith(`app-chat:${handle}:team:`) ||
              !(error.errorType === 'interrupted' || !error.error || /stopp|interrupt|cancel/i.test(error.error))),
          }
        }, { conversationId, handle: script.handle! }), { timeout: 30000 }).toEqual({ active: false, unexpected: [] })
        expect(script.childRequests).toHaveLength(requestCount)
        expect(subagentEffects(acceptanceApp.profile)).toEqual(before)
        expect(script.errors).toEqual([])
        expect(endpoint.errors).toEqual([])
        await info.attach('assigned-child-stream-cancellation', { body: JSON.stringify({ engine: sdkEngine, parent: parent.conversationId, handle: script.handle, before, after: subagentEffects(acceptanceApp.profile), exchanges: endpoint.exchanges }, null, 2), contentType: 'application/json' })
      } finally {
        gate.release()
        await endpoint.close()
      }
    })
  })

  runTest.describe(`Assigned run cancellation on ${sdkEngine}`, () => {
    runTest.use({ sdkEngine })
    runTest('stopping an automation run cancels its assigned provider stream without late child creation', acceptance('models.subagent-profiles.stop', { boundary: 'run-stop', engine: sdkEngine }), async ({ window, model, automation }, info) => {
      runTest.setTimeout(180000)
      const endpoint = await startAcceptanceModel()
      const gate = createModelGate()
      const script = assignmentRoutingScript({ run: true })
      model.respond(script.parent)
      endpoint.respond(request => {
        script.child(request)
        return { text: 'Assigned run verification is running.', hold: gate.promise }
      })
      try {
        await configureRoutingTarget(window, endpoint)
        await openAutomation(window, automation)
        const run = await startAutomation(window, automation.appId)
        await expect.poll(() => script.childRequests.length, { timeout: 90000 }).toBeGreaterThan(0)
        const before = subagentEffects(automation.session.profile)
        const stopped = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appStopRun(input), { appId: automation.appId, runId: run.runId })
        expect(stopped.success, stopped.error).toBe(true)
        await expect.poll(() => endpoint.exchanges.every(exchange => exchange.cancelled), { timeout: 30000 }).toBe(true)
        const requestCount = script.childRequests.length
        gate.release()
        await expect.poll(async () => {
          const result = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appGetState(appId), automation.appId)
          expect(result.success, result.error).toBe(true)
          return (result.data as { status: string }).status
        }, { timeout: 30000 }).not.toBe('running')
        expect(script.childRequests).toHaveLength(requestCount)
        expect(subagentEffects(automation.session.profile)).toEqual(before)
        expect(script.errors).toEqual([])
        expect(endpoint.errors).toEqual([])
        await info.attach('assigned-run-stop', { body: JSON.stringify({ engine: sdkEngine, runId: run.runId, before, after: subagentEffects(automation.session.profile), exchanges: endpoint.exchanges }, null, 2), contentType: 'application/json' })
      } finally {
        gate.release()
        await endpoint.close()
      }
    })
  })
}
