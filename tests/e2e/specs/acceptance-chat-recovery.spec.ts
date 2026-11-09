import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, acceptance, readAcceptanceConversation, readAcceptanceErrors,
  sendAcceptanceMessage, waitForAcceptanceIdle,
} from '../fixtures/acceptance-app'
import { modelTool } from '../fixtures/acceptance-model'
import { openManagedConversation, openManagedPerson, seedManagedPerson } from '../fixtures/acceptance-management'
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

async function waitForPersonIdle(page: Page, appId: string, conversationId: string) {
  await expect.poll(() => page.evaluate(async input => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId)
    if (!result.success) throw new Error(`Could not read the real person session: ${result.error}`)
    return (result.data as { isActive: boolean }).isActive
  }, { appId, conversationId })).toBe(false)
}

async function readPersonChat(page: Page, appId: string, spaceId: string, conversationId: string) {
  const saved = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId, spaceId, conversationId })
  expect(saved.success, 'The person chat must be readable from its stored record').toBe(true)
  return saved.data!.messages
}

test('a digital human chat keeps showing why a blocked account was refused after the turn ends', acceptance('chat.execution.digital-human-provider-error'), async ({ model, window }, info) => {
  const reason = `OAuth authentication is currently not allowed for this organization. ${randomUUID()}`
  const question = `Request from a blocked account ${randomUUID()}`
  const followUp = `Request after the account is restored ${randomUUID()}`
  const answer = `Answer after the account is restored ${randomUUID()}`
  const unexpected: number[] = []
  let restored = false
  model.respond(request => {
    if (!restored) return { failure: { status: 403, type: 'permission_error', message: reason } }
    if (request.lastUserText.includes(followUp)) return { text: answer }
    unexpected.push(request.sequence)
    return { text: 'Unexpected request.' }
  })
  await navigateToChat(window)
  const person = await seedManagedPerson(window, `Blocked account owner ${randomUUID().slice(0, 8)}`)
  await openManagedPerson(window, person.spec.name)
  await window.getByTitle('Opens the conversation with this digital human in the workspace chat', { exact: true }).click()
  await expect(window.getByTitle(`Chatting with ${person.spec.name}`, { exact: true })).toBeVisible()
  await expect(window.locator('.message-assistant')).toHaveCount(0)

  const failed = await sendAcceptanceMessage(window, question)
  expect(failed.conversationId).toMatch(new RegExp(`^app-chat:${person.id}:local:`))
  await waitForPersonIdle(window, person.id, failed.conversationId)
  const refused = await readPersonChat(window, person.id, failed.spaceId, failed.conversationId)
  expect(refused.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
  const failures = refused.filter(message => message.role === 'assistant')
  expect(failures.map(message => ({ content: message.content, error: message.error }))).toEqual([
    { content: '', error: expect.stringContaining(reason) },
  ])
  // The live error card is cleared once the finished turn is redrawn; the stored row must carry the reason.
  const storedFailure = window.locator(`[data-message-id="${failures[0].id}"]`)
  await expect(storedFailure.getByText('Something went wrong', { exact: true })).toBeVisible()
  await expect(storedFailure).toContainText(reason)
  const errors = await readAcceptanceErrors(window)
  expect(errors.length).toBeGreaterThan(0)
  for (const error of errors) expect(error).toMatchObject({ type: 'error', conversationId: failed.conversationId, error: expect.stringContaining(reason) })
  expect(model.exchanges).toHaveLength(1)
  expect(model.exchanges[0].reply?.failure?.status).toBe(403)

  restored = true
  const next = await sendAcceptanceMessage(window, followUp)
  expect(next.conversationId).toBe(failed.conversationId)
  await expect(window.locator('.message-assistant [data-message-content]').last()).toHaveText(answer)
  await waitForPersonIdle(window, person.id, next.conversationId)
  await expect(storedFailure).toContainText(reason)
  const history = await readPersonChat(window, person.id, next.spaceId, next.conversationId)
  expect(history.filter(message => message.role === 'user').map(message => message.content)).toEqual([question, followUp])
  expect(history.filter(message => message.role === 'assistant').map(message => ({ content: message.content, failed: !!message.error }))).toEqual([
    { content: '', failed: true },
    { content: answer, failed: false },
  ])
  expect(unexpected).toEqual([])
  expect(model.exchanges).toHaveLength(2)
  const resent = model.exchanges[1].request
  expect(resent.lastUserText).toContain(followUp)
  expect(resent.text).toContain(question)
  expect(resent.text).not.toContain(reason)
  const allErrors = await readAcceptanceErrors(window)
  for (const error of allErrors) expect(error).toMatchObject({ conversationId: failed.conversationId, error: expect.stringContaining(reason) })
  await info.attach('person-provider-failure', { body: JSON.stringify({ appId: person.id, conversationId: failed.conversationId, errors: allErrors, refused, history }, null, 2), contentType: 'application/json' })
})

test('consecutive question cards deliver single, multiple and custom answers under the full question text', acceptance('chat.execution.structured-answers'), async ({ model, window }, info) => {
  const prompt = `Help me decide how to prepare two reports ${randomUUID()}`
  const answer = `Both reports are ready to prepare ${randomUUID()}`
  const header = 'Decision'
  const option = (label: string) => ({ label, description: `Use ${label.toLowerCase()}.` })
  const batches = ['first', 'second'].map((report, index) => ({
    id: `report-decisions-${report}`,
    questions: [
      { question: `Where should I prepare the ${report} report?`, header, multiSelect: false, options: [option('Local draft'), option('Shared draft')] },
      { question: `Which sections should the ${report} report include?`, header, multiSelect: true, options: [option('Summary'), option('Chart'), option('Appendix')] },
      { question: `When should I deliver the ${report} report?`, header, multiSelect: false, options: [option('Weekday'), option('Weekend')] },
    ],
    single: index === 0 ? 'Local draft' : 'Shared draft',
    multiple: index === 0 ? ['Summary', 'Chart'] : ['Chart', 'Appendix'],
    custom: index === 0 ? 'After the review, at 09:30' : 'Before the launch, at 16:45',
  }))
  model.respond(request => {
    const batch = batches[request.sequence - 1]
    return batch
      ? { tools: [modelTool(request, 'AskUserQuestion', { questions: batch.questions }, batch.id)] }
      : { text: answer }
  })

  await navigateToChat(window)
  const turn = await sendAcceptanceMessage(window, prompt)
  const observations: Array<{ sequence: number; toolId: string; decisions: string[][] }> = []
  for (const [index, batch] of batches.entries()) {
    const card = window.locator('.ask-question-card').filter({ hasText: batch.questions[0].question })
    await expect(card).toBeVisible()
    await expect(window.locator('.ask-question-card')).toHaveCount(1)
    const submit = card.getByRole('button', { name: 'Submit', exact: true })
    await expect(submit).toBeDisabled()
    await expect(card.getByPlaceholder('Type your answer...', { exact: true })).toHaveCount(0)
    for (const question of batch.questions) {
      const section = card.getByText(question.question, { exact: true }).locator('../..')
      await expect(section.getByText(header, { exact: true })).toBeVisible()
      await expect(section.locator('button svg.lucide-check')).toHaveCount(0)
    }
    expect(model.exchanges).toHaveLength(index + 1)

    const single = card.getByText(batch.questions[0].question, { exact: true }).locator('../..')
    const selectedSingle = batch.questions[0].options.find(choice => choice.label === batch.single)!
    await single.getByRole('button', { name: `${selectedSingle.label} ${selectedSingle.description}`, exact: true }).click()
    await expect(single.locator('button svg.lucide-check')).toHaveCount(1)
    await expect(submit).toBeDisabled()
    const multiple = card.getByText(batch.questions[1].question, { exact: true }).locator('../..')
    for (const label of batch.multiple) {
      const selected = batch.questions[1].options.find(choice => choice.label === label)!
      await multiple.getByRole('button', { name: `${selected.label} ${selected.description}`, exact: true }).click()
    }
    await expect(multiple.locator('button svg.lucide-check')).toHaveCount(2)
    await expect(submit).toBeDisabled()
    const custom = card.getByText(batch.questions[2].question, { exact: true }).locator('../..')
    await custom.getByRole('button', { name: 'Other...', exact: true }).click()
    const customInput = custom.getByPlaceholder('Type your answer...', { exact: true })
    await expect(customInput).toHaveValue('')
    await expect(submit).toBeDisabled()
    await customInput.fill(`  ${batch.custom}  `)
    await expect(submit).toBeEnabled()
    expect(model.exchanges).toHaveLength(index + 1)
    await submit.click()

    await expect.poll(() => model.exchanges.length).toBe(index + 2)
    const continuation = model.exchanges[index + 1].request
    expect(continuation.toolResults.map(result => result.id)).toEqual(batches.slice(0, index + 1).map(value => value.id))
    const result = continuation.toolResults.find(value => value.id === batch.id)!
    expect(result.error).toBe(false)
    const decisions = Array.from(result.text.matchAll(/^Question: (.+)\nAnswer: (.*)$/gm), match => [match[1], match[2]])
    expect(decisions).toEqual([
      [batch.questions[0].question, batch.single],
      [batch.questions[1].question, batch.multiple.join(', ')],
      [batch.questions[2].question, batch.custom],
    ])
    observations.push({ sequence: continuation.sequence, toolId: batch.id, decisions })
  }
  await expect(window.locator('.message-assistant [data-message-content]').last()).toHaveText(answer)
  await waitForAcceptanceIdle(window, turn.conversationId)
  await expect(window.locator('.ask-question-card')).toHaveCount(0)
  expect(model.exchanges).toHaveLength(3)
  expect(model.exchanges.every(exchange => exchange.completed && !exchange.cancelled)).toBe(true)
  await info.attach('question-answer-decisions', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
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
