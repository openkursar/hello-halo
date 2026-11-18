import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { commandWorkspace, openCommandWorkspace } from '../fixtures/acceptance-terminal'
import { createCollaborationCompactionScript, compactionStart, compactionReady, compactionContinue, compactionDone, compactionFinding, compactionSummary } from '../fixtures/acceptance-collaboration-compaction'

for (const trigger of ['manual', 'auto'] as const) {
  test.describe(`Collaboration recovery after ${trigger} compaction`, () => {
    test.use({ sdkEngine: 'halo' })
    test('contacts every original collaborator using the plain-language recovery reminder', acceptance('teams.collaboration.compaction-recovery', { trigger }), async ({ acceptanceApp, window, model }, info) => {
      test.setTimeout(180000)
      const script = createCollaborationCompactionScript(trigger)
      model.respond(script.reply)
      const space = await commandWorkspace(window, acceptanceApp.profile, `Compaction ${trigger}`)
      writeFileSync(join(space.workingDir, compactionFinding), 'Synthetic retained collaboration evidence.\n')
      await openCommandWorkspace(window, space)
      const turn = await sendAcceptanceMessage(window, compactionStart + '\n' + 'Earlier project evidence remains read-only. '.repeat(2000))
      await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: compactionReady }).last()).toBeVisible({ timeout: 120000 })
      await waitForAcceptanceIdle(window, turn.conversationId)
      expect(script.errors).toEqual([])
      expect(script.created).toHaveLength(2)
      const association = () => window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), turn.conversationId)
      const before = await association()
      expect(before.success).toBe(true)
      const scope = before.data as { teamId: string; epochId: string; members: Array<{ appId: string }> }
      for (const member of script.created) await waitForAcceptanceIdle(window, buildTeamSessionKey(member.handle, scope.teamId, scope.epochId))
      await sendAcceptanceMessage(window, 'Keep the existing work ready; no new collaborators.', { expectedTarget: turn })
      await waitForAcceptanceIdle(window, turn.conversationId)
      script.arm()
      if (trigger === 'manual') {
        await window.locator('textarea').first().fill('/compact')
        await window.locator('[data-onboarding="send-button"]').click()
        await expect.poll(() => script.summaries, { timeout: 60000 }).toBeGreaterThan(0)
        await waitForAcceptanceIdle(window, turn.conversationId)
      }
      await sendAcceptanceMessage(window, compactionContinue, { expectedTarget: turn })
      await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: compactionDone }).last()).toBeVisible({ timeout: 120000 })
      await waitForAcceptanceIdle(window, turn.conversationId)
      expect(script.errors).toEqual([])
      expect(model.errors).toEqual([])
      expect(script.summaries).toBeGreaterThan(0)
      expect(script.rejected).toBe(trigger === 'auto')
      expect(script.recovered.length).toBeGreaterThan(0)
      const recovered = script.recovered[0]
      for (const member of script.created) {
        expect(recovered.members).toContain(member.name)
        expect(compactionSummary).not.toContain(member.name)
      }
      expect(recovered.lines.some(line => line.startsWith('Recent activity: '))).toBe(true)
      expect(recovered.raw).not.toContain('lead (')
      await info.attach('collaboration-compaction-reminder', { body: recovered.raw, contentType: 'text/plain' })
      const after = await association()
      expect(after).toMatchObject({ success: true, data: { teamId: scope.teamId, epochId: scope.epochId } })
      expect((after.data as typeof scope).members.map(member => member.appId).sort()).toEqual(script.created.map(member => member.handle).sort())
      const spawnCalls = model.exchanges.flatMap(exchange => exchange.reply?.tools ?? []).filter(tool => tool.name.endsWith('__spawn_agent') || tool.name === 'spawn_agent' || tool.name === 'CallTool' && tool.input.tool === 'mcp__halo-team__spawn_agent')
      expect(spawnCalls).toHaveLength(2)
      for (const member of script.created) {
        const transcript = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: member.handle, spaceId: turn.spaceId, conversationId: buildTeamSessionKey(member.handle, scope.teamId, scope.epochId) })
        expect(transcript.success).toBe(true)
        expect(transcript.data!.messages.some(message => message.role === 'assistant' && message.content.includes('COMPACTION_REPORT_'))).toBe(true)
      }
      await info.attach('collaboration-compaction-recovery', { body: JSON.stringify({ trigger, before, after, created: script.created, recovered: script.recovered, summaries: script.summaries, rejected: script.rejected, errors: script.errors }), contentType: 'application/json' })
    })
  })
}
