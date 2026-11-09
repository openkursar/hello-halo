import type { HaloAPI } from '../../../src/preload'
import type { EngineSessionBinding } from '../../../src/shared/types/engine-session'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createEngineCollaborationScript, engineSourceQuestion, engineSourceAnswer, engineMemberResult, engineMemberAssignment, engineFollowup, engineRestartReady, engineResumeQuestion } from '../fixtures/acceptance-engine-collaboration'
import { navigateToChat } from '../fixtures/helpers'
import { openManagedConversation } from '../fixtures/acceptance-management'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) {
  test.describe(`Collaboration through ${sdkEngine}`, () => {
    test.use({ sdkEngine, aiSource: async ({ model }, use) => {
      await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'gpt-4o' })
    } })
    test('creates a collaborator, resumes it for follow-up and receives its answer in the source', acceptance('teams.collaboration.engine-parity', { engine: sdkEngine }), async ({ acceptanceApp, model, window }, testInfo) => {
      test.setTimeout(180000)
      const script = createEngineCollaborationScript({ restartBeforeFollowup: sdkEngine === 'dsh' })
      let page = window
      let beforeRestart: { teamId: string; epochId: string; handle: string; source: EngineSessionBinding; member: EngineSessionBinding } | undefined
      model.respond(script.reply)
      await navigateToChat(page)
      await page.getByRole('button', { name: 'Add files, context and capabilities', exact: true }).click()
      const capability = page.getByRole('menuitemcheckbox', { name: /Team Collaboration/ })
      await expect(capability).toHaveCount(0)
      await page.keyboard.press('Escape')
      const turn = await sendAcceptanceMessage(page, engineSourceQuestion)
      if (sdkEngine === 'dsh') {
        await expect(page.locator('.message-assistant [data-message-content]').filter({ hasText: engineRestartReady }).last()).toBeVisible({ timeout: 120000 })
        await waitForAcceptanceIdle(page, turn.conversationId)
        expect(script.errors).toEqual([])
        expect(script.followedUp).toBe(false)
        const priorSource = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(input.spaceId, input.conversationId), turn)
        expect(priorSource.success).toBe(true)
        const source = priorSource.data as { title: string; engineBinding: EngineSessionBinding }
        const priorAssociation = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), turn.conversationId)
        expect(priorAssociation.success).toBe(true)
        const scope = priorAssociation.data as { teamId: string; epochId: string; members: Array<{ appId: string }> }
        expect(scope.members.map(member => member.appId)).toEqual([script.created!.handle])
        const memberKey = buildTeamSessionKey(script.created!.handle, scope.teamId, scope.epochId)
        await waitForAcceptanceIdle(page, memberKey)
        const priorMember = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), {
          appId: script.created!.handle, spaceId: turn.spaceId, conversationId: memberKey,
        })
        expect(priorMember.success).toBe(true)
        beforeRestart = { teamId: scope.teamId, epochId: scope.epochId, handle: script.created!.handle, source: source.engineBinding, member: priorMember.data!.engineBinding! }
        page = await acceptanceApp.restart(() => { script.resumeAfterRestart() })
        const availability = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
        expect(availability).toMatchObject({ success: true, data: { activeEngine: 'dsh', degradedFrom: null } })
        await openManagedConversation(page, source.title, turn.spaceId)
        const resumed = await sendAcceptanceMessage(page, engineResumeQuestion, { expectedTarget: turn })
        expect(resumed.conversationId).toBe(turn.conversationId)
      }
      await expect(page.locator('.message-assistant [data-message-content]').filter({ hasText: engineSourceAnswer }).last()).toBeVisible({ timeout: 120000 })
      await waitForAcceptanceIdle(page, turn.conversationId)
      expect(script.errors).toEqual([])
      expect(script.created?.handle).toBeTruthy()
      expect(script.followedUp).toBe(true)
      const source = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(input.spaceId, input.conversationId), turn)
      expect(source.success).toBe(true)
      expect((source.data as { engineBinding?: EngineSessionBinding }).engineBinding).toMatchObject({ engineId: sdkEngine })
      const association = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), turn.conversationId)
      expect(association.success).toBe(true)
      const scope = association.data as { teamId: string; epochId: string; members: Array<{ appId: string }> }
      expect(scope.members.map(member => member.appId)).toEqual([script.created!.handle])
      const member = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), {
        appId: script.created!.handle, spaceId: turn.spaceId,
        conversationId: buildTeamSessionKey(script.created!.handle, scope.teamId, scope.epochId),
      })
      expect(member.success).toBe(true)
      expect(member.data?.engineBinding, 'The collaborator must execute with the same actual engine').toMatchObject({ engineId: sdkEngine })
      expect(member.data!.messages.some(message => message.role === 'assistant' && message.content.includes(engineMemberResult))).toBe(true)
      expect(member.data?.engineBinding?.sessionId).not.toBe((source.data as { engineBinding: EngineSessionBinding }).engineBinding.sessionId)
      if (beforeRestart) {
        expect(scope).toMatchObject({ teamId: beforeRestart.teamId, epochId: beforeRestart.epochId })
        expect(script.created!.handle).toBe(beforeRestart.handle)
        expect((source.data as { engineBinding: EngineSessionBinding }).engineBinding.sessionId).not.toBe(beforeRestart.source.sessionId)
        expect(member.data!.engineBinding!.sessionId).not.toBe(beforeRestart.member.sessionId)
        expect(script.restoredSourceRequests.length).toBeGreaterThan(0)
        expect(script.restoredMemberRequests.length).toBeGreaterThan(0)
        for (const sequence of script.restoredSourceRequests) {
          const request = model.exchanges.find(exchange => exchange.request.sequence === sequence)!.request
          expect(request.text).toContain(engineSourceQuestion)
          expect(request.text).toContain(beforeRestart.handle)
        }
        for (const sequence of script.restoredMemberRequests) {
          const request = model.exchanges.find(exchange => exchange.request.sequence === sequence)!.request
          expect(request.text).toContain(engineMemberAssignment)
          expect(request.text).toContain(engineFollowup)
        }
      }
      await testInfo.attach('collaboration-engine-ownership', { body: JSON.stringify({ requested: sdkEngine, source: (source.data as { engineBinding?: EngineSessionBinding }).engineBinding, member: member.data?.engineBinding, scope, handle: script.created!.handle, beforeRestart, restoredSourceRequests: script.restoredSourceRequests, restoredMemberRequests: script.restoredMemberRequests }, null, 2), contentType: 'application/json' })
    })
  })
}
