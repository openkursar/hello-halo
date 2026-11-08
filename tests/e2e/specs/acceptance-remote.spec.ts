import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/acceptance-remote'
import { acceptance, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createModelGate } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'
import type { HaloAPI } from '../../../src/preload'
import type { AgentSendRequest } from '../../../src/shared/types/agent-send'
import type { TranscriptMessage } from '../../../src/shared/types/transcript'

interface PngImage { width: number; height: number; data: Buffer }
const { PNG } = createRequire(import.meta.url)('pngjs') as {
  PNG: { sync: { read(bytes: Buffer): PngImage; write(image: PngImage): Buffer } }
}

async function sendRemote(page: Page, message: string) {
  await page.locator('textarea').first().fill(message)
  await page.locator('[data-onboarding="send-button"]').click()
}

test('remote web login, streaming and reconnection preserve the conversation', acceptance('remote.session.chat-reconnect'), async ({ model, remote }) => {
  test.setTimeout(120000)
  const gate = createModelGate()
  model.respond(request => {
    if (request.lastUserText.includes('Start my remote conversation.')) return { text: 'Your remote answer is streaming.', hold: gate.promise }
    if (request.lastUserText.includes('Continue after reconnecting.')) {
      expect(request.text).toContain('Start my remote conversation.')
      return { text: 'Your remote conversation continued after reconnecting.' }
    }
    throw new Error(`Unexpected remote chat request ${request.sequence}`)
  })
  await remote.login()
  await navigateToChat(remote.page)
  await sendRemote(remote.page, 'Start my remote conversation.')
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your remote answer is streaming.')
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toBeVisible()
  expect(model.exchanges[0]?.completed).toBe(false)
  gate.release()
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  remote.disconnect()
  await expect(remote.page.getByText('Reconnecting...', { exact: true })).toBeVisible()
  remote.reconnect()
  await expect(remote.page.getByText('Reconnecting...', { exact: true })).toHaveCount(0, { timeout: 30000 })
  await expect(remote.page.locator('.message-user')).toHaveCount(1)
  await expect(remote.page.locator('.message-assistant')).toHaveCount(1)
  await sendRemote(remote.page, 'Continue after reconnecting.')
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your remote conversation continued after reconnecting.')
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  await expect(remote.page.locator('.message-user')).toHaveCount(2)
  await remote.page.reload()
  await navigateToChat(remote.page)
  await remote.page.getByText('Start my remote conversation.', { exact: true }).first().click()
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your remote conversation continued after reconnecting.')
})

for (const images of ['single', 'multiple'] as const) {
  test(`remote ${images} images above the small JSON limit reach the model and survive refresh`, acceptance('remote.session.images', { images }), async ({ acceptanceApp, model, remote }, info) => {
    test.setTimeout(120000)
    const count = images === 'single' ? 1 : 2
    const width = images === 'single' ? 256 : 128
    const height = images === 'single' ? 192 : 128
    const fixtures = Array.from({ length: count }, (_, index) => {
      const pixels = randomBytes(width * height * 4)
      for (let at = 3; at < pixels.length; at += 4) pixels[at] = 255
      pixels.set([64 + index * 64, 96, 160, 255], 0)
      const buffer = PNG.sync.write({ width, height, data: pixels })
      expect(PNG.sync.read(buffer).data.equals(pixels)).toBe(true)
      return { name: `remote-image-${index + 1}.png`, mimeType: 'image/png', buffer, pixels }
    })
    const message = `Remote images: ${images}.`
    const reply = 'The remote image message arrived.'
    model.respond(() => ({ text: reply }))
    await remote.login()
    if (images === 'multiple') await remote.page.setViewportSize({ width: 390, height: 844 })
    await navigateToChat(remote.page)
    await remote.page.locator('input[type="file"]').setInputFiles(fixtures.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })))
    await expect(remote.page.getByTitle('Remove image', { exact: true })).toHaveCount(count)

    const requestPromise = remote.page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/agent/message')
    await sendRemote(remote.page, message)
    const request = await requestPromise
    const requestBytes = request.postDataBuffer()!.length
    const sent = request.postDataJSON() as AgentSendRequest
    expect(requestBytes).toBeGreaterThan(100 * 1024)
    expect(sent.images).toHaveLength(count)
    for (const [index, image] of sent.images!.entries()) {
      expect(image.mediaType).toBe('image/png')
      const decoded = PNG.sync.read(Buffer.from(image.data, 'base64'))
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width, height })
      expect(decoded.data.equals(fixtures[index].pixels)).toBe(true)
      if (images === 'multiple') expect(Buffer.byteLength(image.data)).toBeLessThan(100 * 1024)
    }
    const response = await request.response()
    expect(response?.status()).toBe(200)
    expect(await response!.json()).toMatchObject({ success: true })
    await expect(remote.page.locator('.message-assistant').last()).toContainText(reply)
    await waitForAcceptanceIdle(acceptanceApp.window, sent.conversationId)
    await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)

    const exchanges = model.exchanges.filter(exchange => exchange.request.lastUserText.includes(message))
    expect(exchanges).toHaveLength(1)
    const received = exchanges[0].request.messages.filter(item => item.role === 'user')
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(part => part.type === 'image' || part.type === 'image_url')
    expect(received).toHaveLength(count)
    for (const [index, image] of received.entries()) {
      const expected = sent.images![index]
      expect(image.type === 'image_url'
        ? image.image_url?.url === `data:${expected.mediaType};base64,${expected.data}`
        : image.source?.media_type === expected.mediaType && image.source?.data === expected.data).toBe(true)
    }

    expect(sent.spaceId).toBe('halo-temp')
    const file = join(acceptanceApp.profile, '.halo/temp/conversations', `${sent.conversationId}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { title: string; messages: TranscriptMessage[] }
    const user = saved.messages.find(item => item.role === 'user' && item.content === message)!
    expect(user).toBeTruthy()
    expect(JSON.stringify(user.images) === JSON.stringify(sent.images)).toBe(true)
    await remote.page.reload()
    await navigateToChat(remote.page)
    if (images === 'multiple') {
      await remote.page.getByTitle('Conversation history', { exact: true }).click()
      await remote.page.locator('p.truncate').filter({ hasText: saved.title }).click()
    } else {
      await remote.page.getByText(saved.title, { exact: true }).first().click()
    }
    await expect(remote.page.locator('.message-user')).toHaveCount(1)
    await expect(remote.page.locator('.message-assistant').last()).toContainText(reply)
    const restored = remote.page.locator(`[data-message-id="${user.id}"] img`)
    await expect(restored).toHaveCount(count)
    await expect.poll(() => restored.evaluateAll(nodes => nodes.map(node => {
      const image = node as HTMLImageElement
      return { loaded: image.complete && image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight }
    }))).toEqual(Array.from({ length: count }, () => ({ loaded: true, width, height })))
    expect(await restored.evaluateAll((nodes, sources) => nodes.every((node, index) => (node as HTMLImageElement).src === sources[index]),
      sent.images!.map(image => `data:${image.mediaType};base64,${image.data}`))).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).messages).toEqual(saved.messages)
    expect(model.exchanges.filter(exchange => exchange.request.lastUserText.includes(message))).toHaveLength(1)
    await info.attach('remote-image-delivery', { body: JSON.stringify({ images, count, requestBytes, viewport: remote.page.viewportSize(), storedMessageId: user.id }), contentType: 'application/json' })
  })
}

test('rotating the access code rejects old browser requests and requires a fresh UI login', acceptance('remote.access.rotate'), async ({ acceptanceApp, model, remote }) => {
  test.setTimeout(120000)
  model.respond(request => {
    if (request.lastUserText.includes('Confirm my original remote login.')) return { text: 'Your original remote login works.' }
    if (request.lastUserText.includes('Confirm my renewed remote login.')) return { text: 'Your renewed remote login works.' }
    throw new Error(`An unauthorized or unexpected remote message reached the model: ${request.sequence}`)
  })
  await remote.login()
  await navigateToChat(remote.page)
  await sendRemote(remote.page, 'Confirm my original remote login.')
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your original remote login works.')
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  const oldCode = await remote.page.evaluate(() => localStorage.getItem('halo_remote_token'))
  const changed = await acceptanceApp.window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.regenerateRemotePassword())
  expect(changed.success).toBe(true)
  const newCode = (changed.data as { server: { token: string } }).server.token
  expect(newCode === oldCode).toBe(false)
  await sendRemote(remote.page, 'This old connection must not start work.')
  await expect(remote.page.getByPlaceholder('Access Code', { exact: true })).toBeVisible({ timeout: 30000 })
  expect(model.exchanges).toHaveLength(1)
  await remote.page.getByPlaceholder('Access Code', { exact: true }).fill(oldCode!)
  await remote.page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(remote.page.getByText('Invalid code', { exact: true })).toBeVisible()
  await remote.login(newCode)
  await navigateToChat(remote.page)
  await sendRemote(remote.page, 'Confirm my renewed remote login.')
  await expect(remote.page.locator('.message-assistant').last()).toContainText('Your renewed remote login works.')
  await expect(remote.page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  expect(model.exchanges).toHaveLength(2)
})
