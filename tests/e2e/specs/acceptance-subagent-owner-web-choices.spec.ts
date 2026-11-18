import { test, expect, acceptance } from '../fixtures/acceptance-owner-remote'
import { startAcceptanceModel } from '../fixtures/acceptance-model'
import { prepareOwnerChoice, ownerChoiceScript, assertOwnerChoiceWire, assertOwnerFailure } from '../fixtures/acceptance-subagent-owner-choices'
import { configureRoutingTarget, assignmentRoutingScript } from '../fixtures/acceptance-subagent-routing'

test.use({ headless: true })

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Remote owner choices on ${sdkEngine}`, () => {
  test.beforeAll(() => {
    if (process.env.HALO_E2E_HIDDEN_WINDOWS !== '1') throw new Error('Remote owner acceptance requires HALO_E2E_HIDDEN_WINDOWS=1')
  })
  test.use({ sdkEngine, aiSource: async ({ model }, use) => {
    await use({ provider: 'openai', apiType: 'chat_completions', apiKey: 'local-scripted-endpoint', apiUrl: model.url, model: 'o3' })
  } })
  for (const choice of ['inherit', 'profile', 'effort-only', 'provider-failure'] as const) {
    test(`Remote owner applies ${choice}`, acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'owner-web', choice }), async ({ window, model, remoteDesktop }, info) => {
      test.setTimeout(180000)
      const page = remoteDesktop.page
      const http: Array<{ method: string; path: string; status: number }> = []
      let receivedFrames = 0
      page.on('response', response => {
        const target = new URL(response.url())
        if (target.origin === remoteDesktop.url && target.pathname.startsWith('/api/')) http.push({ method: response.request().method(), path: target.pathname, status: response.status() })
      })
      page.on('websocket', socket => { socket.on('framereceived', () => { receivedFrames++ }) })
      const assigned = choice === 'profile' ? await startAcceptanceModel() : undefined
      const failed = choice === 'profile' ? undefined : await prepareOwnerChoice(window, choice)
      try {
        const marker = `REMOTE_OWNER_CHOICE:${choice}`
        const routing = assigned ? assignmentRoutingScript({ sourceMarker: marker }) : undefined
        const ordinary = choice === 'profile' ? undefined : ownerChoiceScript(choice, { sourceMarker: marker })
        if (assigned && routing) {
          await configureRoutingTarget(window, assigned)
          model.respond(routing.parent)
          assigned.respond(routing.child)
        } else model.respond(ordinary!.reply)
        await remoteDesktop.login()
        await page.locator('textarea').first().fill(marker)
        await page.locator('[data-onboarding="send-button"]').click()
        const final = assigned ? 'The assignment returned assigned-target-confirmed.' : 'owner-choice-parent-complete'
        await expect(page.getByText(final, { exact: true }).first()).toBeVisible({ timeout: 120000 })
        if (routing && assigned) {
          expect(routing.errors).toEqual([])
          expect(routing.handle).toBeTruthy()
          expect(routing.childRequests.length).toBeGreaterThan(0)
          expect(routing.parentRequests.some(request => request.toolResults.some(result => result.id === 'assigned-spawn') && request.text.includes('assigned-target-confirmed'))).toBe(true)
          for (const request of routing.parentRequests) expect(request.body.model).toBe('o3')
          for (const request of routing.childRequests) expect(request.body.model).toBe('gpt-4o')
          expect(assigned.errors).toEqual([])
        } else {
          assertOwnerChoiceWire(ordinary!, choice as 'inherit' | 'effort-only' | 'provider-failure')
          assertOwnerFailure(failed, ordinary!)
          expect(ordinary!.parents.some(request => request.toolResults.some(result => result.id === 'owner-choice-spawn') && (choice === 'provider-failure' ? ordinary!.reviewedFailure : request.text.includes('owner-choice-child-complete')))).toBe(true)
        }
        expect(http.some(request => request.method === 'POST' && /\/agent\/.*send|\/agent\/message/.test(request.path) && request.status < 400)).toBe(true)
        expect(receivedFrames).toBeGreaterThan(0)
        expect(model.errors).toEqual([])
        await info.attach('owner-web-execution', { body: JSON.stringify({ engine: sdkEngine, choice, http, receivedFrames, parents: routing?.parentRequests ?? ordinary?.parents, children: routing?.childRequests ?? ordinary?.children }, null, 2), contentType: 'application/json' })
      } finally {
        await assigned?.close()
        await failed?.close()
      }
    })
  }
})
