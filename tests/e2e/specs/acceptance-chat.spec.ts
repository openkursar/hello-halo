import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from '../fixtures/acceptance-app'
import { createModelGate, modelTool } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(90000)

test('space messages survive an application restart and remain available to the next turn', acceptance('chat.messages.persist'), async ({ acceptanceApp, model, window }) => {
  const token = randomUUID()
  let replies = 0
  const receivedContext: boolean[] = []
  model.respond(request => {
    if (request.lastUserText.includes(`Remember this reference: ${token}`)) return { text: `Reference saved: ${token}` }
    if (request.lastUserText.includes('Repeat the reference I gave you.')) {
      receivedContext.push(request.text.includes(`Remember this reference: ${token}`))
      replies++
      return { text: `The reference is ${token}` }
    }
    throw new Error(`Unexpected chat request ${request.sequence}`)
  })
  await navigateToChat(window)
  const first = await sendAcceptanceMessage(window, `Remember this reference: ${token}`)
  await expect(window.locator('.message-assistant').last()).toContainText(`Reference saved: ${token}`)
  await waitForAcceptanceIdle(window, first.conversationId)
  expect(await window.locator('textarea').first().inputValue()).toBe('')
  const second = await sendAcceptanceMessage(window, 'Repeat the reference I gave you.')
  expect(second.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText(`The reference is ${token}`)
  await waitForAcceptanceIdle(window, first.conversationId)
  const saved = await readAcceptanceConversation(window, first.spaceId, first.conversationId)
  expect(saved.messages.filter(message => message.role === 'user')).toHaveLength(2)
  expect(saved.messages.filter(message => message.role === 'assistant').at(-1)?.content).toContain(token)

  const reopened = await acceptanceApp.restart()
  await navigateToChat(reopened)
  await reopened.getByText(saved.title, { exact: true }).first().click()
  await expect(reopened.locator('.message-assistant').last()).toContainText(`The reference is ${token}`)
  const resumed = await sendAcceptanceMessage(reopened, 'Repeat the reference I gave you.')
  expect(resumed.conversationId).toBe(first.conversationId)
  await expect(reopened.locator('.message-assistant').last()).toContainText(`The reference is ${token}`)
  await waitForAcceptanceIdle(reopened, resumed.conversationId)
  const afterRestart = await readAcceptanceConversation(reopened, first.spaceId, first.conversationId)
  expect(afterRestart.messages.filter(message => message.role === 'user')).toHaveLength(3)
  expect(replies).toBe(2)
  expect(receivedContext, 'The model must receive the original reference both before and after restart').toEqual([true, true])
})

test('a supplement sent while a real tool is running reaches the next model step', acceptance('chat.messages.live-input'), async ({ acceptanceApp, model, window }) => {
  const ready = join(acceptanceApp.profile, 'command-ready')
  const released = join(acceptanceApp.profile, 'command-released')
  const script = join(acceptanceApp.profile, 'wait-for-supplement.cjs')
  const supplement = `Include this late instruction: ${randomUUID()}`
  writeFileSync(script, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready')`,
    'const started = Date.now()',
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) { clearInterval(timer); process.stdout.write('ACCEPTANCE_COMMAND_FINISHED'); } else if (Date.now() - started > 20000) { clearInterval(timer); process.stderr.write('The test did not release the command'); process.exitCode = 1; } }, 40)`,
  ].join('\n'))
  const command = `"${process.execPath}" "${script}"`
  let sawSupplement = false
  model.respond(request => {
    const result = request.toolResults.find(result => result.id === 'acceptance-wait-tool')
    if (result) {
      expect(result.error).toBe(false)
      expect(result.text).toContain('ACCEPTANCE_COMMAND_FINISHED')
      expect(request.text).toContain(supplement)
      sawSupplement = true
      return { text: `Completed with the late instruction. ${supplement}` }
    }
    if (request.lastUserText.includes('Begin the work and wait for my supplement.')) return { tools: [modelTool(request, 'Bash', { command, timeout: 30000, run_in_background: false }, 'acceptance-wait-tool')] }
    throw new Error(`Unexpected live-input request ${request.sequence}`)
  })
  await navigateToChat(window)
  const turn = await sendAcceptanceMessage(window, 'Begin the work and wait for my supplement.')
  try {
    await expect.poll(() => existsSync(ready), { timeout: 20000 }).toBe(true)
    await expect(window.getByTitle('Stop generation (Esc)', { exact: true })).toBeVisible()
    await window.locator('textarea').first().fill(supplement)
    await window.locator('[data-onboarding="send-button"]').click()
    await expect(window.locator('textarea').first()).toHaveValue('')
    writeFileSync(released, 'continue')
    await expect(window.locator('.message-assistant').last()).toContainText(supplement, { timeout: 30000 })
    await waitForAcceptanceIdle(window, turn.conversationId)
    expect(sawSupplement).toBe(true)
    const history = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
    expect(history.messages.filter(message => message.role === 'user').some(message => message.content.includes(supplement))).toBe(true)
  } finally {
    writeFileSync(released, 'cleanup')
  }
})

test('an image selected in the composer reaches the model and remains in message history', acceptance('chat.attachments.image'), async ({ model, window }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64')
  let imageCount = 0
  model.respond(request => {
    expect(request.lastUserText).toContain('Check the attached image.')
    const parts = request.messages.filter(message => message.role === 'user').flatMap(message => Array.isArray(message.content) ? message.content : [])
    const images = parts.filter(part => part.type === 'image_url' || part.type === 'image')
    expect(images).toHaveLength(1)
    const image = images[0]
    if (image.type === 'image_url') expect(image.image_url.url).toMatch(/^data:image\/(png|jpeg|webp);base64,.+/)
    else expect(image.source).toMatchObject({ type: 'base64', data: expect.any(String) })
    imageCount++
    return { text: 'The attached image arrived with your message.' }
  })
  await navigateToChat(window)
  await window.locator('input[type="file"]').setInputFiles({ name: 'acceptance-image.png', mimeType: 'image/png', buffer: png })
  await expect(window.getByTitle('Remove image', { exact: true })).toBeVisible()
  const turn = await sendAcceptanceMessage(window, 'Check the attached image.')
  await expect(window.locator('.message-assistant').last()).toContainText('The attached image arrived with your message.')
  await waitForAcceptanceIdle(window, turn.conversationId)
  const history = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
  expect(history.messages.find(message => message.role === 'user')?.images).toHaveLength(1)
  expect(imageCount).toBe(1)
  await window.getByRole('button', { name: 'Conversation', exact: true }).first().click()
  await expect(window.locator('.message-user img').first()).toBeVisible()
})

test('stopping a streaming answer cancels its request and permits another turn', acceptance('chat.execution.stop-resume'), async ({ model, window }) => {
  const gate = createModelGate()
  model.respond(request => {
    if (request.lastUserText.includes('Keep working until I stop you.')) return { text: 'The response is still running.', hold: gate.promise }
    if (request.lastUserText.includes('Continue with a new request.')) return { text: 'The new request completed.' }
    throw new Error(`Unexpected stop-and-resume request ${request.sequence}`)
  })
  await navigateToChat(window)
  const first = await sendAcceptanceMessage(window, 'Keep working until I stop you.')
  await expect(window.locator('.message-assistant').last()).toContainText('The response is still running.')
  await window.getByTitle('Stop generation (Esc)', { exact: true }).click()
  const interruption = {
    type: 'error', errorType: 'interrupted', error: 'Stopped by user.',
    conversationId: first.conversationId, spaceId: first.spaceId,
  }
  await waitForAcceptanceIdle(window, first.conversationId, { expectedErrors: [interruption] })
  await expect.poll(() => model.exchanges[0]?.cancelled).toBe(true)
  expect(model.exchanges[0]?.completed).toBe(false)
  const next = await sendAcceptanceMessage(window, 'Continue with a new request.')
  expect(next.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('The new request completed.')
  await waitForAcceptanceIdle(window, next.conversationId, { expectedErrors: [interruption] })
  const history = await readAcceptanceConversation(window, next.spaceId, next.conversationId)
  expect(history.messages.filter(message => message.role === 'user')).toHaveLength(2)
  expect(history.messages.at(-1)?.content).toContain('The new request completed.')
})
