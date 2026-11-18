import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { test, expect, acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { initialUserInput, type ModelRequest } from '../fixtures/acceptance-model'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { securityConversation, securityTool } from '../fixtures/acceptance-subagent-security'

test.use({ startupObserver: fileURLToPath(new URL('../fixtures/subagent-idle-clock-observer.cjs', import.meta.url)) })
for (const boundary of ['restart', 'idle'] as const) {
test(`restore a simulated legacy member without inventing its missing reasoning snapshot after ${boundary}`, acceptance('models.subagent-profiles.restore', { change: 'legacy-no-snapshot', boundary }), async ({ window, model, acceptanceApp }, info) => {
  test.setTimeout(240000)
  let handle: string | undefined
  let resumed = false
  let followupId = 'legacy-followup'
  let followupMarker = 'LEGACY_FOLLOWUP'
  const children: ModelRequest[] = []
  model.respond(request => {
    if (initialUserInput(request).includes('LEGACY_CHILD:')) {
      children.push(request)
      return { text: resumed ? 'LEGACY_HISTORY_RESTORED' : 'LEGACY_ORIGINAL_HISTORY_CANARY' }
    }
    if (resumed) {
      if (request.toolResults.some(result => result.id === followupId)) return { text: 'LEGACY_PARENT_FINISHED' }
      return securityTool(request, 'team_send', { to: handle, message: `${followupMarker}: Continue your original assignment.` }, followupId)
    }
    const created = request.toolResults.find(result => result.id === 'legacy-spawn')
    if (created) { handle = collaboratorReceipt(created).handle; return { text: 'LEGACY_PARENT_READY' } }
    return securityTool(request, 'spawn_agent', { name: 'Legacy restoration worker', prompt: 'LEGACY_CHILD: Remember the original assignment.' }, 'legacy-spawn')
  })
  const conversationId = await securityConversation(window, 'LEGACY_PARENT: Create an inherited worker without advanced configuration.')
  await expect.poll(() => Boolean(handle) && children.length > 0, { timeout: 90000 }).toBe(true)
  await waitForAcceptanceIdle(window, conversationId)
  const before = children.length
  const originalModel = children[0].body.model
  resumed = true
  const reopened = await acceptanceApp.restart(profile => {
    const output = execFileSync(electronPath as unknown as string, [fileURLToPath(new URL('../fixtures/subagent-legacy-record.cjs', import.meta.url)), profile, handle!], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: profile, USERPROFILE: profile }, encoding: 'utf8', timeout: 10000,
    })
    const evidence = JSON.parse(output)
    expect(evidence.member).toBe(handle)
    expect(evidence.transcriptAfter).toBe(evidence.transcriptBefore)
    return info.attach('simulated-legacy-record-mutation', { body: output, contentType: 'application/json' })
  })
  await securityConversation(reopened, 'LEGACY_PARENT_FOLLOWUP: Continue the existing worker only.', conversationId)
  await expect.poll(() => children.length, { timeout: 90000 }).toBeGreaterThan(before)
  await waitForAcceptanceIdle(reopened, conversationId)
  const restored = children.slice(before)
  expect(restored.every(request => request.body.model === originalModel)).toBe(true)
  expect(restored.some(request => request.text.includes('LEGACY_ORIGINAL_HISTORY_CANARY') && request.text.includes('LEGACY_FOLLOWUP'))).toBe(true)
  if (boundary === 'idle') {
    const nativeBefore = await acceptanceApp.app.evaluate(() => (globalThis as any).subagentIdleClock.sessions())
    const childBefore = children.length
    await acceptanceApp.app.evaluate(() => (globalThis as any).subagentIdleClock.advance())
    try {
      await expect.poll(async () => (await acceptanceApp.app.evaluate(() => (globalThis as any).subagentIdleClock.observations())).some((entry: { conversationId: string }) => entry.conversationId.includes(handle!)), { timeout: 75000 }).toBe(true)
      await expect.poll(() => acceptanceApp.app.evaluate(() => (globalThis as any).subagentIdleClock.sessions()), { timeout: 10000 }).toEqual(expect.arrayContaining(nativeBefore.filter((session: { closed: boolean }) => !session.closed).map((session: object) => ({ ...session, closed: true }))))
    } finally { await acceptanceApp.app.evaluate(() => (globalThis as any).subagentIdleClock.reset()) }
    followupId = 'legacy-idle-followup'
    followupMarker = 'LEGACY_IDLE_FOLLOWUP'
    await securityConversation(reopened, 'LEGACY_PARENT_IDLE_FOLLOWUP: Continue the existing legacy worker.', conversationId)
    await expect.poll(() => children.length, { timeout: 60000 }).toBeGreaterThan(childBefore)
    await waitForAcceptanceIdle(reopened, conversationId)
    expect(children.slice(childBefore).some(request => request.text.includes('LEGACY_ORIGINAL_HISTORY_CANARY') && request.text.includes('LEGACY_FOLLOWUP') && request.text.includes('LEGACY_IDLE_FOLLOWUP'))).toBe(true)
  }
  await info.attach('legacy-restoration-wire', { body: JSON.stringify({ handle, requests: children }, null, 2), contentType: 'application/json' })
})
}
