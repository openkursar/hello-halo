import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { modelTool, type AcceptanceModel } from '../fixtures/acceptance-model'
import { openManagedPerson, seedManagedPerson } from '../fixtures/acceptance-management'
import { navigateToChat } from '../fixtures/helpers'
import { haloFileUrlToPath } from '../../../src/shared/halo-file-url'

test.setTimeout(150000)

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (const byte of body) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length)
  return out
}

/** A small striped PNG, distinct per test so its saved file is too. */
function stripedPng(seed: number): Buffer {
  const width = 96
  const height = 64
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3
      const band = Math.floor(x / 12) % 2
      rows[at] = band ? 40 : (seed * 37) % 256
      rows[at + 1] = band ? 120 : 200
      rows[at + 2] = band ? 220 : 60
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/** The model reads the image with the real Read tool, then answers; records whether the image reached it. */
function scriptImageRead(model: AcceptanceModel, request: string, file: string, png: Buffer, answer: string) {
  const seen = { image: false, unexpected: [] as number[] }
  const base64 = png.toString('base64')
  model.respond(next => {
    if (!next.lastUserText.includes(request)) {
      seen.unexpected.push(next.sequence)
      return { text: 'Unexpected request.' }
    }
    const result = next.toolResults.find(item => item.id === 'read-chart')
    if (!result) return { tools: [modelTool(next, 'Read', { file_path: file }, 'read-chart')] }
    expect(result.error).toBe(false)
    seen.image ||= JSON.stringify(next.body).includes(base64)
    return { text: answer }
  })
  return seen
}

/** Opens the reply's work process and, if it is folded, the Read step's result; returns the image shown there. */
async function openImageStep(reply: Locator): Promise<Locator> {
  const header = reply.getByRole('button', { name: /^Already thought/ }).first()
  await expect(header).toBeVisible()
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click()
  const image = reply.locator('[data-testid="tool-result-images"] img').first()
  const showResult = reply.getByTitle('Show tool result', { exact: true }).first()
  await expect(image.or(showResult)).toBeVisible()
  if (!await image.isVisible()) await showResult.click()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth)).toBe(96)
  return image
}

/** The image is shown from a file saved by content in `folderPattern`, holding exactly the bytes the tool read. */
async function expectSavedImage(image: Locator, png: Buffer, folderPattern: RegExp): Promise<string> {
  const source = await image.getAttribute('src')
  expect(source).toMatch(/^halo-file:\/\//)
  const path = haloFileUrlToPath(source!)
  expect(path).toMatch(folderPattern)
  expect(readFileSync(path).equals(png)).toBe(true)
  return path
}

function filesUnder(folder: string, suffix: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesUnder(join(folder, entry.name), suffix)
    : entry.name.endsWith(suffix) ? [join(folder, entry.name)] : [])
}

test('a step that read an image shows the image in a space chat, also after a restart', acceptance('chat.work-process.tool-image', { surface: 'space' }), async ({ acceptanceApp, model, window }, info) => {
  const png = stripedPng(1)
  const file = join(acceptanceApp.profile, '.halo', 'temp', 'artifacts', `chart-${randomUUID().slice(0, 8)}.png`)
  mkdirSync(join(acceptanceApp.profile, '.halo', 'temp', 'artifacts'), { recursive: true })
  writeFileSync(file, png)
  const request = `Look at the chart image ${randomUUID()}`
  const answer = `The chart has stripes ${randomUUID()}`
  const seen = scriptImageRead(model, request, file, png, answer)

  await navigateToChat(window)
  const turn = await sendAcceptanceMessage(window, request)
  await expect(window.locator('.message-assistant [data-message-content]').last()).toHaveText(answer)
  await waitForAcceptanceIdle(window, turn.conversationId)
  expect(seen.image, 'The model must receive the image the tool read').toBe(true)
  expect(seen.unexpected).toEqual([])

  const besideConversation = new RegExp(`[\\\\/]${turn.conversationId}\\.images[\\\\/][0-9a-f]{16}\\.png$`)
  const reply = window.locator('.message-assistant').last().locator('xpath=ancestor::*[@data-transcript-index][1]')
  const saved = await expectSavedImage(await openImageStep(reply), png, besideConversation)

  const thoughts = readFileSync(join(acceptanceApp.profile, '.halo', 'temp', 'conversations', `${turn.conversationId}.thoughts.json`), 'utf8')
  expect(thoughts).not.toContain(png.toString('base64'))
  const stored = (Object.values((JSON.parse(thoughts) as { messages: Record<string, Array<{ toolName?: string; toolResult?: { output: string } }>> }).messages)
    .flat().find(thought => thought.toolName === 'Read')?.toolResult?.output) ?? ''
  expect(stored).toContain('"type":"image_file"')

  const reopened = await acceptanceApp.restart()
  await navigateToChat(reopened)
  const savedReply = reopened.locator('.message-assistant').filter({ hasText: answer }).last().locator('xpath=ancestor::*[@data-transcript-index][1]')
  await expect(savedReply).toBeVisible()
  expect(await expectSavedImage(await openImageStep(savedReply), png, besideConversation)).toBe(saved)
  await info.attach('tool-image-space', { body: JSON.stringify({ conversationId: turn.conversationId, modelSawImage: seen.image, savedImage: saved }), contentType: 'application/json' })
})

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Opens the person's only chat from the sidebar. After a restart its row reads
 * as its latest message or, without one, its date — never a fixed text.
 */
async function openPersonChat(page: Page, name: string) {
  const section = page.getByTitle('Conversations with digital humans available in this workspace', { exact: true })
  await section.waitFor({ state: 'visible', timeout: 15000 })
  if (await section.getAttribute('aria-expanded') !== 'true') await section.click()
  const group = page.getByRole('button', { name, exact: true }).first()
  await group.waitFor({ state: 'visible' })
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  // The section header sits in its own wrapper; the rows are beside that wrapper.
  await section.locator('xpath=../..').getByText(/^(Chat \d+-\d+ \d+:\d\d|Look at the person chart .*|The person chart has stripes .*)$/).first().click()
}

async function waitForPersonIdle(page: Page, appId: string, conversationId: string) {
  await expect.poll(() => page.evaluate(async input => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId)
    if (!result.success) throw new Error(`Could not read the person session: ${result.error}`)
    return (result.data as { isActive: boolean }).isActive
  }, { appId, conversationId })).toBe(false)
}

test('a step that read an image shows the image in a digital human chat, also after a restart', acceptance('chat.work-process.tool-image', { surface: 'digital-human' }), async ({ acceptanceApp, model, window }, info) => {
  const png = stripedPng(2)
  const folder = join(acceptanceApp.profile, 'person-files')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `chart-${randomUUID().slice(0, 8)}.png`)
  writeFileSync(file, png)
  const request = `Look at the person chart ${randomUUID()}`
  const answer = `The person chart has stripes ${randomUUID()}`
  const seen = scriptImageRead(model, request, file, png, answer)

  await navigateToChat(window)
  const person = await seedManagedPerson(window, `Chart reader ${randomUUID().slice(0, 8)}`)
  await openManagedPerson(window, person.spec.name)
  await window.getByTitle('Opens the conversation with this digital human in the workspace chat', { exact: true }).click()
  await expect(window.getByTitle(`Chatting with ${person.spec.name}`, { exact: true })).toBeVisible()
  const turn = await sendAcceptanceMessage(window, request)
  await expect(window.locator('.message-assistant [data-message-content]').last()).toHaveText(answer)
  await waitForPersonIdle(window, person.id, turn.conversationId)
  expect(seen.image, 'The model must receive the image the tool read').toBe(true)
  expect(seen.unexpected).toEqual([])

  const transcriptPaths = filesUnder(join(acceptanceApp.profile, '.halo'), '.jsonl').filter(name => readFileSync(name, 'utf8').includes(request))
  expect(transcriptPaths).toHaveLength(1)
  const transcript = readFileSync(transcriptPaths[0], 'utf8')
  expect(transcript).not.toContain(png.toString('base64'))
  expect(transcript).toContain('"type":"image_file"')
  // The images belong to the transcript: saved beside it, removed and copied with it.
  const besideTranscript = new RegExp(`[\\\\/]runs[\\\\/]${escapeRegExp(basename(transcriptPaths[0], '.jsonl'))}\\.images[\\\\/][0-9a-f]{16}\\.png$`)
  const reply = window.locator('.message-assistant').filter({ hasText: answer }).last().locator('xpath=ancestor::*[@data-transcript-index][1]')
  const saved = await expectSavedImage(await openImageStep(reply), png, besideTranscript)

  const reopened = await acceptanceApp.restart()
  await navigateToChat(reopened)
  await openPersonChat(reopened, person.spec.name)
  const savedReply = reopened.locator('.message-assistant').filter({ hasText: answer }).last().locator('xpath=ancestor::*[@data-transcript-index][1]')
  await expect(savedReply).toBeVisible()
  expect(await expectSavedImage(await openImageStep(savedReply), png, besideTranscript)).toBe(saved)
  expect(existsSync(file)).toBe(true)
  await info.attach('tool-image-person', { body: JSON.stringify({ conversationId: turn.conversationId, modelSawImage: seen.image, savedImage: saved }), contentType: 'application/json' })
})
