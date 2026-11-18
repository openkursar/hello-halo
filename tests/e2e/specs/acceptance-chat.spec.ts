import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
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

test('supplements sent while a real tool is running reach the next model step', acceptance('chat.messages.live-input'), async ({ acceptanceApp, model, window }) => {
  const ready = join(acceptanceApp.profile, 'command-ready')
  const released = join(acceptanceApp.profile, 'command-released')
  const script = join(acceptanceApp.profile, 'wait-for-supplement.cjs')
  const supplement = `Include this late instruction: ${randomUUID()}`
  const secondSupplement = `Also preserve this second instruction: ${randomUUID()}`
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
      expect(request.text).toContain(secondSupplement)
      expect(request.text.indexOf(supplement)).toBeLessThan(request.text.indexOf(secondSupplement))
      sawSupplement = true
      return { text: `Completed with the late instructions. ${supplement}\n${secondSupplement}` }
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
    await window.locator('textarea').first().fill(secondSupplement)
    await window.locator('[data-onboarding="send-button"]').click()
    await expect(window.locator('textarea').first()).toHaveValue('')
    writeFileSync(released, 'continue')
    await expect(window.locator('.message-assistant').last()).toContainText(supplement, { timeout: 30000 })
    await expect(window.locator('.message-assistant').last()).toContainText(secondSupplement)
    await waitForAcceptanceIdle(window, turn.conversationId)
    expect(sawSupplement).toBe(true)
    const history = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
    expect(history.messages.filter(message => message.role === 'user').some(message => message.content.includes(supplement))).toBe(true)
    expect(history.messages.filter(message => message.role === 'user').some(message => message.content.includes(secondSupplement))).toBe(true)
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

test('reading an empty image leaves the conversation usable for a follow-up', acceptance('chat.attachments.empty-tool-image'), async ({ acceptanceApp, model, window }) => {
  const image = join(acceptanceApp.profile, '.halo/temp/artifacts', 'empty-image.png')
  writeFileSync(image, '')
  model.respond(request => {
    if (request.lastUserText.includes('Continue after the unavailable image.')) return { text: 'The follow-up completed.' }
    const result = request.toolResults.find(item => item.id === 'read-empty-image')
    if (result) return { text: 'The image file is empty; no image was attached.' }
    return { tools: [modelTool(request, 'Read', { file_path: image }, 'read-empty-image')] }
  })
  await navigateToChat(window)
  const first = await sendAcceptanceMessage(window, `Read the image at ${image}.`)
  await expect(window.locator('.message-assistant').last()).toContainText('The image file is empty; no image was attached.')
  await waitForAcceptanceIdle(window, first.conversationId)
  const next = await sendAcceptanceMessage(window, 'Continue after the unavailable image.')
  expect(next.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('The follow-up completed.')
  await waitForAcceptanceIdle(window, next.conversationId)
  expect(model.exchanges).toHaveLength(3)
  expect(model.exchanges[1].request.toolResults.find(item => item.id === 'read-empty-image')?.text).toContain('No image was attached.')
  for (const exchange of model.exchanges) {
    const messages = JSON.stringify(exchange.request.messages)
    expect(messages).not.toContain('"type":"image"')
    expect(messages).not.toContain('"type":"image_url"')
  }
  const history = await readAcceptanceConversation(window, next.spaceId, next.conversationId)
  expect(history.messages.filter(message => message.role === 'user')).toHaveLength(2)
  expect(history.messages.at(-1)?.content).toContain('The follow-up completed.')
})

function imageBudgetPng(seed: number): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name)
    const body = Buffer.concat([type, data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const header = Buffer.alloc(4)
    header.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, body, checksum])
  }
  const width = 768
  const height = 640
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  for (let offset = 0; offset < pixels.length; offset += 32) {
    const block = createHash('sha256').update(`image-budget-${seed}-${offset}`).digest()
    block.copy(pixels, offset, 0, Math.min(block.length, pixels.length - offset))
  }
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

function storedImageData(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const part = value as Record<string, any>
  if (part.type === 'image' && part.source?.type === 'base64') return [part.source.data]
  if (part.type === 'image_url' && typeof part.image_url?.url === 'string') return [part.image_url.url.split(';base64,')[1]].filter(Boolean)
  return Object.values(part).flatMap(storedImageData)
}

test('large multi-turn Read image history reaches the router without blocking the conversation', acceptance('chat.attachments.image-history-budget'), async ({ acceptanceApp, model, window }, info) => {
  const images = Array.from({ length: 12 }, (_, index) => {
    const file = join(acceptanceApp.profile, '.halo/temp/artifacts', `budget-${index}.png`)
    const png = imageBudgetPng(index)
    expect(png.length).toBeLessThan(5 * 1024 * 1024)
    expect(png.toString('base64').length).toBeGreaterThan(1.8 * 1024 * 1024)
    writeFileSync(file, png)
    return { file, data: png.toString('base64') }
  })
  const decoded = await acceptanceApp.app.evaluate(({ nativeImage }, files) => files.map(file => {
    const image = nativeImage.createFromPath(file)
    return { empty: image.isEmpty(), ...image.getSize() }
  }), images.map(image => image.file))
  expect(decoded).toEqual(images.map(() => ({ empty: false, width: 768, height: 640 })))
  const total = images.reduce((sum, image) => sum + image.data.length, 0)
  expect(total).toBeGreaterThan(20 * 1024 * 1024)
  expect(images.every(image => image.data.length < 3.5 * 1024 * 1024)).toBe(true)
  const observations: Array<{ batch: number; images: string[]; placeholders: number }> = []
  model.respond(request => {
    if (request.lastUserText.includes('Continue after the large image history.')) return { text: 'The same conversation is still usable.' }
    const batch = request.text.includes('Read image batch two.') ? 1 : 0
    const lastId = `budget-read-${batch * 6 + 5}`
    if (request.toolResults.some(result => result.id === lastId)) {
      const received = storedImageData(request.messages)
      observations.push({ batch, images: received, placeholders: request.text.split('[Screenshot removed — exceeded image budget for API request]').length - 1 })
      return { text: `Image batch ${batch + 1} completed.` }
    }
    return { tools: images.slice(batch * 6, batch * 6 + 6).map((image, offset) => modelTool(request, 'Read', { file_path: image.file }, `budget-read-${batch * 6 + offset}`)) }
  })
  await navigateToChat(window)
  const first = await sendAcceptanceMessage(window, 'Read image batch one.')
  await expect(window.locator('.message-assistant').last()).toContainText('Image batch 1 completed.', { timeout: 30000 })
  await waitForAcceptanceIdle(window, first.conversationId)
  const second = await sendAcceptanceMessage(window, 'Read image batch two.')
  expect(second.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('Image batch 2 completed.', { timeout: 30000 })
  await waitForAcceptanceIdle(window, first.conversationId)
  expect(observations).toHaveLength(2)
  for (const observation of observations) {
    expect(observation.images).toEqual([images[observation.batch * 6 + 5].data])
    expect(observation.images.reduce((sum, data) => sum + data.length, 0)).toBeLessThanOrEqual(3.5 * 1024 * 1024)
    expect(observation.placeholders).toBe((observation.batch + 1) * 6 - 1)
  }
  const next = await sendAcceptanceMessage(window, 'Continue after the large image history.')
  expect(next.conversationId).toBe(first.conversationId)
  await expect(window.locator('.message-assistant').last()).toContainText('The same conversation is still usable.')
  await waitForAcceptanceIdle(window, next.conversationId)
  const history = await readAcceptanceConversation(window, next.spaceId, next.conversationId)
  expect(history.messages.filter(message => message.role === 'user')).toHaveLength(3)
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
  const histories = files(acceptanceApp.profile).filter(file => file.endsWith('.jsonl') && !file.includes('/artifacts/'))
  const retained = new Set(histories.flatMap(file => {
    const contents = readFileSync(file, 'utf8')
    return images.filter(image => contents.includes(image.data)).map(image => image.file)
  }))
  expect(retained.size, 'Actual persisted execution history must retain every original tool image').toBe(images.length)
  await info.attach('image-history-budget', { body: JSON.stringify({ originalBase64Bytes: total, retainedOriginalImages: retained.size, requests: model.exchanges.length, observations: observations.map(observation => ({ batch: observation.batch, retainedImages: observation.images.length, base64Bytes: observation.images.reduce((sum, data) => sum + data.length, 0), placeholders: observation.placeholders })) }), contentType: 'application/json' })
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
