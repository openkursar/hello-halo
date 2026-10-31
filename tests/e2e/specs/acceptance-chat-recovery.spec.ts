import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test, expect, acceptance, readAcceptanceConversation, readAcceptanceErrors,
  sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import { modelTool } from '../fixtures/acceptance-model'
import { openManagedConversation } from '../fixtures/acceptance-management'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(150000)

test('a visible provider rejection retains the request and permits a successful manual retry', acceptance('chat.execution.provider-error'), async ({ model, window }, info) => {
  const marker = `Synthetic provider rejection ${randomUUID()}`
  const question = `Recover this isolated request ${randomUUID()}`
  const answer = `Recovered answer ${randomUUID()}`
  let recovered = false
  model.respond(() => recovered ? { text: answer } : { failure: { status: 401, type: 'authentication_error', message: marker } })
  await navigateToChat(window)
  const failed = await sendAcceptanceMessage(window, question)
  await expect(window.getByText('Something went wrong', { exact: true }).first()).toBeVisible()
  await expect(window.getByText(marker, { exact: false }).first()).toBeVisible()
  const errors = await readAcceptanceErrors(window)
  for (const error of errors) expect(error).toMatchObject({ type: 'error', conversationId: failed.conversationId, spaceId: failed.spaceId, error: expect.stringContaining(marker) })
  await waitForAcceptanceIdle(window, failed.conversationId, { expectedErrors: errors })
  const before = await readAcceptanceConversation(window, failed.spaceId, failed.conversationId)
  expect(before.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
  expect(before.messages.some(message => message.error?.includes(marker))).toBe(true)
  expect(before.messages.some(message => message.role === 'assistant' && message.content.trim() && !message.error)).toBe(false)
  expect(model.exchanges.length).toBeGreaterThan(0)
  expect(model.exchanges.every(exchange => exchange.reply?.failure?.status === 401)).toBe(true)
  const rejectedRequests = model.exchanges.length

  recovered = true
  const retry = await sendAcceptanceMessage(window, question)
  expect(retry.conversationId).toBe(failed.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText(answer)
  await waitForAcceptanceIdle(window, retry.conversationId, { expectedErrors: errors })
  const after = await readAcceptanceConversation(window, retry.spaceId, retry.conversationId)
  expect(after.messages.filter(message => message.role === 'user' && message.content === question)).toHaveLength(2)
  expect(after.messages.filter(message => message.role === 'assistant' && message.content === answer && !message.error)).toHaveLength(1)
  expect(after.messages.some(message => message.error?.includes(marker))).toBe(true)
  const completed = model.exchanges.slice(rejectedRequests).filter(exchange => exchange.reply?.text === answer && exchange.completed)
  expect(completed).toHaveLength(1)
  expect(completed[0].request.lastUserText).toContain(question)
  await info.attach('provider-failure-recovery', { body: JSON.stringify({ rejectedRequests, retainedRequests: after.messages.filter(message => message.role === 'user').length, completedReplies: after.messages.filter(message => message.content === answer).length }), contentType: 'application/json' })
})

function heldCommand(profile: string, name: string) {
  const ready = join(profile, `${name}-ready`)
  const release = join(profile, `${name}-release`)
  const script = join(profile, `${name}.cjs`)
  const output = `${name}-finished`
  writeFileSync(script, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready')`,
    'const started = Date.now()',
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.stdout.write(${JSON.stringify(output)}); } else if (Date.now() - started > 90000) { clearInterval(timer); process.stderr.write('The test did not release the isolated command'); process.exitCode = 1; } }, 40)`,
  ].join('\n'))
  return { ready, output, input: { command: `"${process.execPath}" "${script}"`, timeout: 100000, run_in_background: false }, release: () => writeFileSync(release, 'continue') }
}

test('two running conversations retain their own replies and only the addressed one receives a supplement', acceptance('chat.messages.isolation'), async ({ acceptanceApp, model, window }, info) => {
  const alpha = { question: `Alpha work ${randomUUID()}`, answer: `Alpha completed ${randomUUID()}`, toolId: 'isolated-alpha-tool', command: heldCommand(acceptanceApp.profile, 'alpha-work') }
  const beta = { question: `Beta work ${randomUUID()}`, answer: `Beta completed ${randomUUID()}`, toolId: 'isolated-beta-tool', command: heldCommand(acceptanceApp.profile, 'beta-work') }
  const supplement = `Only beta needs this extra instruction ${randomUUID()}`
  const observations: Array<{ task: string; ownsQuestion: boolean; hasOtherQuestion: boolean; hasSupplement: boolean; toolSucceeded: boolean }> = []
  model.respond(request => {
    for (const [task, own, other] of [['alpha', alpha, beta], ['beta', beta, alpha]] as const) {
      const result = request.toolResults.find(result => result.id === own.toolId)
      if (result) {
        observations.push({ task, ownsQuestion: request.text.includes(own.question), hasOtherQuestion: request.text.includes(other.question), hasSupplement: request.text.includes(supplement), toolSucceeded: !result.error && result.text.includes(own.command.output) })
        return { text: own.answer }
      }
      if (request.lastUserText.includes(own.question)) return { tools: [modelTool(request, 'Bash', own.command.input, own.toolId)] }
    }
    throw new Error(`Unexpected isolation request ${request.sequence}`)
  })
  try {
    await navigateToChat(window)
    const first = await sendAcceptanceMessage(window, alpha.question)
    await expect.poll(() => existsSync(alpha.command.ready), { timeout: 30000 }).toBe(true)
    const firstHistory = await readAcceptanceConversation(window, first.spaceId, first.conversationId)
    await window.getByRole('button', { name: 'New', exact: true }).first().click()
    await expect(window.locator('.message-user')).toHaveCount(0)
    const second = await sendAcceptanceMessage(window, beta.question)
    expect(second.conversationId).not.toBe(first.conversationId)
    await expect.poll(() => existsSync(beta.command.ready), { timeout: 30000 }).toBe(true)
    await expect(window.getByTitle('Stop generation (Esc)', { exact: true })).toBeVisible()
    await window.locator('textarea').first().fill(supplement)
    await window.locator('[data-onboarding="send-button"]').click()
    await expect(window.locator('textarea').first()).toHaveValue('')
    alpha.command.release()
    await openManagedConversation(window, firstHistory.title, first.spaceId)
    await expect(window.locator('.message-assistant').last()).toContainText(alpha.answer)
    await waitForAcceptanceIdle(window, first.conversationId)
    await expect(window.locator('.message-user').filter({ hasText: beta.question })).toHaveCount(0)
    await expect(window.locator('.message-user').filter({ hasText: supplement })).toHaveCount(0)

    const secondHistory = await readAcceptanceConversation(window, second.spaceId, second.conversationId)
    await openManagedConversation(window, secondHistory.title, second.spaceId)
    await expect(window.getByTitle('Stop generation (Esc)', { exact: true })).toBeVisible()
    await expect(window.locator('.message-assistant').filter({ hasText: alpha.answer })).toHaveCount(0)
    beta.command.release()
    await expect(window.locator('.message-assistant').last()).toContainText(beta.answer)
    await waitForAcceptanceIdle(window, second.conversationId)
    const storedAlpha = await readAcceptanceConversation(window, first.spaceId, first.conversationId)
    const storedBeta = await readAcceptanceConversation(window, second.spaceId, second.conversationId)
    for (const [history, own, other] of [[storedAlpha, alpha, beta], [storedBeta, beta, alpha]] as const) {
      expect(history.messages.filter(message => message.role === 'assistant' && message.content === own.answer)).toHaveLength(1)
      expect(history.messages.some(message => message.content.includes(other.question) || message.content.includes(other.answer))).toBe(false)
    }
    expect(storedAlpha.messages.some(message => message.content.includes(supplement))).toBe(false)
    expect(storedBeta.messages.filter(message => message.role === 'user' && message.content.includes(supplement))).toHaveLength(1)
    expect(observations).toEqual([
      { task: 'alpha', ownsQuestion: true, hasOtherQuestion: false, hasSupplement: false, toolSucceeded: true },
      { task: 'beta', ownsQuestion: true, hasOtherQuestion: false, hasSupplement: true, toolSucceeded: true },
    ])
    await info.attach('conversation-isolation', { body: JSON.stringify({ first: first.conversationId, second: second.conversationId, observations }), contentType: 'application/json' })
  } finally {
    alpha.command.release()
    beta.command.release()
  }
})
