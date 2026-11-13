import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test as imTest, OWNER_ID, imTranscript, waitForImIdle, showImConversation, waitForGuestChannel } from '../fixtures/acceptance-guest'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { parseAppChatKey } from '../../../src/shared/apps/im-keys'
import { test, expect, acceptance, sendAcceptanceMessage, readAcceptanceErrors } from '../fixtures/acceptance-app'
import { openManagedPerson, openManagedPersonSettings, readManagedPerson } from '../fixtures/acceptance-management'
import { navigateToChat, openDigitalHumanConversation } from '../fixtures/helpers'
import { contentText, type ModelRequest } from '../fixtures/acceptance-model'

function systemText(request: ModelRequest): string {
  if (request.body.system !== undefined) return contentText(request.body.system)
  return request.messages.filter(message => message.role === 'system' || message.role === 'developer')
    .map(message => contentText(message.content)).join('\n')
}

async function installPerson(page: Page, name: string, instructions: string): Promise<string> {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({ spaceId: 'halo-temp', spec: {
    spec_version: '1.0', version: '1.0.0', type: 'automation', name: input.name, author: 'Acceptance fixture',
    description: 'Observes synthetic instructions without external actions.', system_prompt: input.instructions,
    subscriptions: [], requires: {}, config_schema: [], permissions: [],
  } }), { name, instructions })
  expect(result.success).toBe(true)
  return (result.data as { appId: string }).appId
}

async function readInstructions(page: Page, appId: string): Promise<string> {
  const { spec } = await readManagedPerson(page, appId)
  if (spec.type !== 'automation') throw new Error('The settings reload fixture must remain an automation digital human')
  return spec.system_prompt
}

async function openNewChat(page: Page, name: string) {
  await openManagedPerson(page, name)
  await page.getByTitle('Opens the conversation with this digital human in the workspace chat', { exact: true }).click()
}

async function assertHistory(page: Page, appId: string, target: { spaceId: string; conversationId: string }, questions: string[]) {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript({ ...input, limit: 100 }), { appId, ...target })
  expect(result.success).toBe(true)
  expect(result.data!.messages.filter((message: { role: string }) => message.role === 'user').map((message: { content: string }) => message.content)).toEqual(questions)
  expect(result.data!.messages.filter((message: { role: string }) => message.role === 'assistant').map((message: { content: string }) => message.content)).toEqual(questions.map(question => `Synthetic observation ${question}`))
}

imTest.describe('Continue an IM conversation with saved Claude Code instructions', () => {
  imTest.use({ sdkEngine: 'anthropic' })
  for (const variant of ['legacy-reload', 'modern-reload', 'legacy-unchanged'] as const) {
    imTest(variant, acceptance('people.settings.im-continue-instructions', { binding: variant }), async ({ guestApp, acceptanceApp, window, model, wecom }, info) => {
      imTest.setTimeout(180000)
      let page = window
      const reload = variant !== 'legacy-unchanged'
      const original = await readInstructions(page, guestApp.appId)
      const updated = `Use only synthetic updated recipient Example New Ltd. ${randomUUID()}`
      const questions = ['source', 'destination', 'restarted'].map(stage => `Observe synthetic recipient ${stage} ${randomUUID()}`)
      const requests: Array<{ question: string; request: ModelRequest }> = []
      const shapes: unknown[] = []
      model.respond(request => {
        const question = questions.find(value => request.lastUserText.includes(value))
        if (question) requests.push({ question, request })
        return { text: question ? `Synthetic observation ${question}` : 'Synthetic auxiliary response.' }
      })
      const bindingsFile = join(guestApp.workDir, '.halo', 'apps', guestApp.appId, 'runs', '_session-ids.json')
      const bindings = () => JSON.parse(readFileSync(bindingsFile, 'utf8')) as Record<string, unknown>
      const runId = (id: string) => `chat-${id.slice(`app-chat:${guestApp.appId}:`.length).replace(/:/g, '-')}`
      const nativeId = (row: unknown): string => {
        const id = typeof row === 'string' ? row : (row as { sessionId?: string; legacySessionId?: string })?.sessionId ?? (row as { legacySessionId?: string })?.legacySessionId
        if (!id) throw new Error('The real native Claude Code session was not persisted')
        return id
      }
      try {
        const sent = await wecom.sendText({ senderId: OWNER_ID, chatId: OWNER_ID, chatType: 'direct', text: questions[0] })
        await wecom.waitForReply({ requestId: sent.requestId, contains: `Synthetic observation ${questions[0]}` })
        await waitForImIdle(page, guestApp, OWNER_ID)
        const source = await imTranscript(page, guestApp, OWNER_ID)
        expect(source.messages.some(message => message.role === 'user' && message.content.includes(questions[0]))).toBe(true)
        const sourceRun = runId(source.conversationId)
        const sourceNativeId = nativeId(bindings()[sourceRun])
        const sourceRequests = requests.filter(entry => entry.question === questions[0])
        expect(sourceRequests.length).toBeGreaterThan(0)
        for (const { request } of sourceRequests) {
          const prompt = systemText(request)
          expect(prompt).toContain(original)
          expect(prompt).not.toContain(updated)
          expect(prompt).toContain('You are Claude Code')
          expect(prompt.match(/^# Halo$/gm)).toHaveLength(1)
          expect(prompt.indexOf('You are Claude Code')).toBeLessThan(prompt.indexOf('# Halo\n'))
        }
        page = await acceptanceApp.restart(profile => {
          const map = bindings()
          expect(map[sourceRun]).toMatchObject({ engineId: 'anthropic', sessionId: sourceNativeId })
          shapes.push({ stage: 'native-created', row: map[sourceRun] })
          if (variant !== 'modern-reload') {
            map[sourceRun] = sourceNativeId
            writeFileSync(bindingsFile, JSON.stringify(map, null, 2))
          }
          const configFile = join(profile, '.halo', 'config.json')
          const config = JSON.parse(readFileSync(configFile, 'utf8'))
          config.agent.legacySdkEngine ??= 'anthropic'
          expect(config.agent.sdkEngine).toBe('anthropic')
          writeFileSync(configFile, JSON.stringify(config, null, 2))
          shapes.push({ stage: 'version-fixture', row: bindings()[sourceRun] })
        })
        await waitForGuestChannel(page, guestApp, wecom)
        if (reload) {
          await openManagedPersonSettings(page, guestApp.appName)
          const identity = page.locator('#settings-group-identity')
          await identity.locator('textarea').fill(updated)
          await identity.getByRole('button', { name: 'Save', exact: true }).click()
          await expect.poll(() => readInstructions(page, guestApp.appId)).toBe(updated)
          await page.getByRole('button', { name: 'Quick restart', exact: true }).click()
          await expect(page.getByRole('button', { name: 'Quick restart', exact: true })).toHaveCount(0)
        }
        const sourceBinding = bindings()[sourceRun]
        shapes.push({ stage: 'before-fork', row: sourceBinding })
        const sourceRequestCount = requests.filter(entry => entry.question === questions[0]).length
        const replyCount = wecom.replies.length
        await showImConversation(page, guestApp, OWNER_ID, `Synthetic observation ${questions[0]}`)
        await page.getByRole('button', { name: 'Continue in client', exact: true }).click()
        const send = async (question: string, target?: { spaceId: string; conversationId: string }) => {
          const result = await sendAcceptanceMessage(page, question, target ? { expectedTarget: target } : undefined)
          await expect(page.locator('.message-assistant [data-message-content]').last()).toHaveText(`Synthetic observation ${question}`)
          await expect.poll(async () => {
            const response = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.id), { appId: guestApp.appId, id: result.conversationId })
            expect(response.success).toBe(true)
            return (response.data as { isActive: boolean }).isActive
          }).toBe(false)
          return result
        }
        const destination = await send(questions[1])
        expect(parseAppChatKey(destination.conversationId)).toMatchObject({ appId: guestApp.appId, channel: 'local' })
        expect(destination.conversationId).not.toBe(source.conversationId)
        const destinationNativeId = nativeId(bindings()[runId(destination.conversationId)])
        expect(destinationNativeId).not.toBe(sourceNativeId)
        const chatName = `Continued instructions ${randomUUID().slice(0, 8)}`
        const parsed = parseAppChatKey(destination.conversationId)!
        const renamed = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.imSessionsSetCustomName(input), { appId: guestApp.appId, channel: parsed.channel, chatId: parsed.chatId, name: chatName })
        expect(renamed.success).toBe(true)
        page = await acceptanceApp.restart()
        await navigateToChat(page)
        await openDigitalHumanConversation(page, guestApp.appName, chatName)
        await send(questions[2], destination)
        for (const question of questions.slice(1)) {
          const observations = requests.filter(entry => entry.question === question)
          expect(observations.length).toBeGreaterThan(0)
          for (const { request } of observations) {
            const prompt = systemText(request)
            expect(prompt).toContain(reload ? updated : original)
            expect(prompt).not.toContain(reload ? original : updated)
            expect(prompt).toContain('You are Claude Code')
            expect(prompt.match(/^# Halo$/gm)).toHaveLength(1)
            expect(prompt.indexOf('You are Claude Code')).toBeLessThan(prompt.indexOf('# Halo\n'))
            expect(request.text).toContain(questions[0])
            if (question === questions[2]) expect(request.text).toContain(questions[1])
          }
        }
        const afterSource = await imTranscript(page, guestApp, OWNER_ID)
        expect(afterSource.messages).toEqual(source.messages)
        expect(bindings()[sourceRun]).toEqual(sourceBinding)
        expect(nativeId(bindings()[runId(destination.conversationId)])).toBe(destinationNativeId)
        expect(requests.filter(entry => entry.question === questions[0])).toHaveLength(sourceRequestCount)
        expect(wecom.replies).toHaveLength(replyCount)
        const continued = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: guestApp.appId, spaceId: destination.spaceId, conversationId: destination.conversationId, limit: 100 })
        expect(continued.success).toBe(true)
        const retained = continued.data!.messages
        for (const prior of source.messages) expect(retained.some(message => message.role === prior.role && message.content === prior.content)).toBe(true)
        for (const question of questions.slice(1)) {
          expect(retained.some(message => message.role === 'user' && message.content === question)).toBe(true)
          expect(retained.some(message => message.role === 'assistant' && message.content === `Synthetic observation ${question}`)).toBe(true)
        }
        expect(await readAcceptanceErrors(page)).toEqual([])
      } finally {
        await info.attach('im-continuation-instruction-observations', { body: JSON.stringify({ variant, appId: guestApp.appId, shapes, requests }, null, 2), contentType: 'application/json' })
      }
    })
  }
})

for (const engine of ['halo', 'anthropic'] as const) {
  test.describe(`Person settings reload with ${engine}`, () => {
    test.use({ sdkEngine: engine })

    for (const reload of [true, false]) {
      const caseId = reload ? 'people.settings.reload-instructions' : 'people.settings.resume-unchanged'
      test(reload ? 'explicit reload updates the original chat and survives application restart' : 'an unchanged stored chat resumes without a settings reload', acceptance(caseId, { engine }), async ({ model, window, acceptanceApp }, info) => {
        const nonce = randomUUID().slice(0, 8)
        const name = `Settings ${engine} ${nonce}`
        const original = `Handle synthetic invoices only. Recipient: Example Old Ltd. Original ${nonce}.`
        const updated = `Handle synthetic invoices only. Recipient: Example New Ltd. Updated ${nonce}.`
        const questions = ['initial', 'reloaded', 'fresh', 'restarted'].map(stage => `Report configured synthetic recipient. ${stage} ${nonce}`)
        const requests: Array<{ question: string; request: ModelRequest }> = []
        model.respond(request => {
          const question = questions.find(question => request.lastUserText.includes(question))
          if (question) requests.push({ question, request })
          return { text: question ? `Synthetic observation ${question}` : 'Synthetic auxiliary response.' }
        })
        let page = window
        await navigateToChat(page)
        const appId = await installPerson(page, name, original)
        const assertRequest = (question: string, instructions: string, prior: string[]) => {
          const observed = requests.filter(entry => entry.question === question)
          expect(observed.length).toBeGreaterThan(0)
          for (const { request } of observed) {
            const prompt = systemText(request)
            expect(prompt).toContain(instructions)
            expect(prompt).not.toContain(instructions === updated ? original : updated)
            const native = engine === 'halo' ? 'You are an exceptional autonomous agent' : 'You are Claude Code'
            expect(prompt).toContain(native)
            expect(prompt.match(/^# Halo$/gm)).toHaveLength(1)
            expect(prompt.indexOf(native)).toBeLessThan(prompt.indexOf('# Halo\n'))
            for (const previous of prior) expect(request.text).toContain(previous)
          }
        }
        const send = async (question: string, expectedTarget?: { spaceId: string; conversationId: string }) => {
          const target = await sendAcceptanceMessage(page, question, expectedTarget ? { expectedTarget } : undefined)
          await expect(page.locator('.message-assistant [data-message-content]').last()).toHaveText(`Synthetic observation ${question}`)
          await expect.poll(async () => {
            const state = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId), { appId, conversationId: target.conversationId })
            expect(state.success).toBe(true)
            return (state.data as { isActive: boolean }).isActive
          }, { timeout: 30000 }).toBe(false)
          expect(await readAcceptanceErrors(page)).toEqual([])
          return target
        }
        try {
          await openNewChat(page, name)
          const initialTurn = await send(questions[0])
          const originalChat = { spaceId: initialTurn.spaceId, conversationId: initialTurn.conversationId }
          assertRequest(questions[0], original, [])
          const history = [questions[0]]
          const chatName = `Saved instructions ${nonce}`
          const chat = parseAppChatKey(originalChat.conversationId)
          if (!chat || chat.appId !== appId || chat.channel !== 'local') throw new Error('The fixture must address its original local conversation')
          const renamed = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.imSessionsSetCustomName(input), {
            appId, channel: chat.channel, chatId: chat.chatId, name: chatName,
          })
          expect(renamed.success).toBe(true)
          if (reload) {
            if (engine === 'anthropic') page = await acceptanceApp.restart()
            await openManagedPersonSettings(page, name)
            const identity = page.locator('#settings-group-identity')
            await identity.locator('textarea').fill(updated)
            await identity.getByRole('button', { name: 'Save', exact: true }).click()
            await expect.poll(async () => await readInstructions(page, appId)).toBe(updated)
            await page.getByRole('button', { name: 'Quick restart', exact: true }).click()
            await expect(page.getByRole('button', { name: 'Quick restart', exact: true })).toHaveCount(0)
            await navigateToChat(page)
            await openDigitalHumanConversation(page, name, chatName)
            expect(await send(questions[1], originalChat)).toMatchObject(originalChat)
            assertRequest(questions[1], updated, history)
            history.push(questions[1])
            await assertHistory(page, appId, originalChat, history)
            await openNewChat(page, name)
            const freshChat = await send(questions[2])
            expect(freshChat.conversationId).not.toBe(originalChat.conversationId)
            assertRequest(questions[2], updated, [])
            expect(requests.find(entry => entry.question === questions[2])!.request.text).not.toContain(questions[0])
            await assertHistory(page, appId, freshChat, [questions[2]])
          }
          page = await acceptanceApp.restart()
          await navigateToChat(page)
          await openDigitalHumanConversation(page, name, chatName)
          expect(await send(questions[3], originalChat)).toMatchObject(originalChat)
          assertRequest(questions[3], reload ? updated : original, history)
          history.push(questions[3])
          await assertHistory(page, appId, originalChat, history)
          expect(await readInstructions(page, appId)).toBe(reload ? updated : original)
        } finally {
          await info.attach('settings-reload-provider-observations', { body: JSON.stringify({ engine, reload, appId, requests }, null, 2), contentType: 'application/json' })
        }
      })
    }
  })
}
