import { randomUUID } from 'node:crypto'
import type { HaloAPI } from '../../../src/preload'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { createModelGate, modelTool } from '../fixtures/acceptance-model'
import { seedManagedSpace } from '../fixtures/acceptance-management'
import { createAwareTeam, installTeammate, memberTranscript } from '../fixtures/acceptance-team-awareness'
import { navigateToApps } from '../fixtures/helpers'

test.setTimeout(120000)

for (const width of [390, 1280]) {
  test(`workbench streams complete paragraphs at ${width}px`, acceptance('chat.streaming.workbench-app-prefix', { viewport: String(width) }), async ({ window, model }) => {
    const token = randomUUID().slice(0, 8)
    const space = await seedManagedSpace(window, `Streaming ${token}`)
    const lead = await installTeammate(window, space.id, `Lead ${token}`, 'Follow the request.')
    const member = await installTeammate(window, space.id, `Reader ${token}`, 'Follow the request.')
    const { team, intended } = await createAwareTeam(window, {
      spaceId: space.id, name: `Streaming team ${token}`, askerAppId: lead, askerRole: 'Lead',
      teammateAppId: member, teammateRole: 'Reader', intendedLabel: `Streaming task ${token}`, unrelatedLabel: `Other task ${token}`,
    })
    await navigateToApps(window)
    await window.getByRole('button', { name: /^Teams\b/ }).click()
    await window.getByRole('button', { name: `Streaming team ${token}`, exact: false }).click()
    await window.getByRole('navigation', { name: 'Tasks', exact: true }).getByRole('button', { name: new RegExp(`Streaming task ${token}`) }).click()
    await window.getByRole('button', { name: 'Task activity', exact: true }).click()
    const drawer = window.getByRole('dialog', { name: 'Task activity', exact: true })
    await drawer.getByRole('button', { name: 'Tester', exact: true }).click()
    await window.setViewportSize({ width, height: 844 })
    const first = createModelGate()
    const last = createModelGate()
    const paragraph = `Every opening character remains visible after the tool call. ${token}`
    model.respond(request => request.toolResults.some(result => result.id === 'stream-tool')
      ? { text: paragraph, hold: last.promise }
      : { text: 'Checking', tools: [modelTool(request, 'Bash', { command: 'printf checked' }, 'stream-tool')], hold: first.promise })
    try {
      const sent = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatSend(input), {
        appId: member, spaceId: space.id, conversationId: buildTeamSessionKey(member, team.id, intended.epochId), message: 'Check and report.',
      })
      expect(sent.success).toBe(true)
      const bubble = drawer.locator('.message-working')
      await expect(bubble).toContainText('Checking')
      first.release()
      await expect(bubble.locator('.break-words').last()).toContainText(paragraph)
      last.release()
      await expect.poll(async () => (await memberTranscript(window, { appId: member, spaceId: space.id, teamId: team.id, epochId: intended.epochId })).some(message => message.role === 'assistant' && message.content.includes(paragraph)), { timeout: 30000 }).toBe(true)
      await window.keyboard.press('Escape')
      await window.getByRole('button', { name: 'Task activity', exact: true }).click()
      await drawer.getByRole('button', { name: 'Tester', exact: true }).click()
      await expect(drawer).toContainText(paragraph)
    } finally {
      first.release()
      last.release()
    }
  })
}
