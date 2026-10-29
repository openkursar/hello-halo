import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, seedManagedConversation, type ManagedConversation } from './acceptance-management'

export async function seedReadingConversation(page: Page, profile: string, count: number, title: string) {
  const token = randomUUID().slice(0, 8)
  const markers = Array.from({ length: count }, (_, index) => `History ${token} message ${String(index + 1).padStart(4, '0')}`)
  const messages = markers.map((marker, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${marker}. ${index % 2 === 0
      ? 'Please keep this saved question available while I read the conversation.'
      : 'This saved answer belongs to its original question. Its text and identity must survive reading older history and receiving a later reply.'}`,
  }))
  const conversation = await seedManagedConversation(page, 'halo-temp', title, messages)
  const file = join(profile, '.halo/temp/conversations', `${conversation.id}.json`)
  const readDisk = () => JSON.parse(readFileSync(file, 'utf8')) as ManagedConversation
  const identities = (value: ManagedConversation) => value.messages.map(({ id, role, content }) => ({ id, role, content }))
  expect(identities(readDisk())).toEqual(identities(conversation))
  return { conversation, markers, file, readDisk, identities }
}

export async function settleReadingLayout(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

export async function readHistoryWindow(scroller: Locator) {
  return scroller.evaluate(element => {
    const started = performance.now()
    const box = element.getBoundingClientRect()
    const visible = new Set<string>()
    for (let y = box.top + 8; y < box.bottom - 8; y += 16) {
      const hit = document.elementFromPoint(box.left + box.width / 2, y)
      const message = hit && element.contains(hit) ? hit.closest<HTMLElement>('[data-message-id]') : null
      if (message?.dataset.messageId) visible.add(message.dataset.messageId)
    }
    const snapshot = {
      top: element.scrollTop,
      height: element.scrollHeight,
      viewport: element.clientHeight,
      distanceToEnd: element.scrollHeight - element.clientHeight - element.scrollTop,
      placeholders: element.querySelectorAll('[data-transcript-index][aria-hidden="true"]').length,
      visibleMessageIds: [...visible],
      rows: Array.from(element.querySelectorAll<HTMLElement>('[data-transcript-index]:not([aria-hidden="true"])')).map(row => ({
        index: Number(row.dataset.transcriptIndex),
        messages: Array.from(row.querySelectorAll<HTMLElement>('[data-message-id]')).map(message => ({ id: message.dataset.messageId!, text: message.textContent ?? '' })),
      })),
    }
    return { ...snapshot, sampleMilliseconds: performance.now() - started }
  })
}

export function assertHistoryWindow(snapshot: Awaited<ReturnType<typeof readHistoryWindow>>, seeded: Awaited<ReturnType<typeof seedReadingConversation>>) {
  const windowName = `History window ${snapshot.rows[0]?.index ?? 'empty'}..${snapshot.rows.at(-1)?.index ?? 'empty'}`
  assert.ok(snapshot.rows.length > 0, `${windowName}: no live message components`)
  assert.ok(snapshot.rows.length <= 300, `${windowName}: more than 300 live message components`)
  const ids: string[] = []
  for (const [position, row] of snapshot.rows.entries()) {
    const record = `${windowName}, row ${row.index}`
    assert.ok(Number.isInteger(row.index) && row.index >= 0 && row.index < seeded.conversation.messages.length, `${record}: invalid history index`)
    if (position > 0) assert.equal(row.index, snapshot.rows[position - 1].index + 1, `${record}: non-contiguous display boundary`)
    assert.equal(row.messages.length, 1, `${record}: expected one saved message`)
    const saved = seeded.conversation.messages[row.index]
    assert.equal(row.messages[0].id, saved.id, `${record}: saved message identity differs`)
    assert.ok(row.messages[0].text.includes(seeded.markers[row.index]), `${record} (${saved.id}): missing message marker`)
    assert.ok(row.messages[0].text.includes(saved.content), `${record} (${saved.id}): missing complete stored text`)
    ids.push(row.messages[0].id)
  }
  assert.equal(new Set(ids).size, ids.length, `${windowName}: duplicate message identities`)
  return ids
}

export interface ReadingAnchor { messageId: string; offset: number }

export async function readReadingAnchor(scroller: Locator): Promise<ReadingAnchor | null> {
  return scroller.evaluate(element => {
    const box = element.getBoundingClientRect()
    for (const offset of [24, 64, 128, 192]) {
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + offset)
      const message = hit && element.contains(hit) ? hit.closest<HTMLElement>('[data-message-id]') : null
      if (message?.dataset.messageId) return { messageId: message.dataset.messageId, offset: message.getBoundingClientRect().top - box.top }
    }
    return null
  })
}

export interface ReadingObservation {
  samples: number
  missing: number
  outside: number
  maximumDrift: number
  initialOffset: number
  lastOffset: number
}

interface ReadingProbe { frame: number; observation: ReadingObservation }
interface ReadingWindow { acceptanceReadingProbe?: ReadingProbe }

export async function watchReadingAnchor(page: Page, anchor: ReadingAnchor) {
  await page.evaluate(anchor => {
    const state = window as unknown as ReadingWindow
    if (state.acceptanceReadingProbe) throw new Error('A reading observer is already active')
    const observation: ReadingObservation = { samples: 0, missing: 0, outside: 0, maximumDrift: 0, initialOffset: anchor.offset, lastOffset: anchor.offset }
    const probe: ReadingProbe = { frame: 0, observation }
    state.acceptanceReadingProbe = probe
    const observe = () => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="transcript-scroller"]')
      const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.messageId)}"]`)
      observation.samples++
      if (!scroller || !row) observation.missing++
      else {
        const box = scroller.getBoundingClientRect()
        const bounds = row.getBoundingClientRect()
        const offset = bounds.top - box.top
        observation.lastOffset = offset
        observation.maximumDrift = Math.max(observation.maximumDrift, Math.abs(offset - anchor.offset))
        if (bounds.bottom <= box.top || bounds.top >= box.bottom) observation.outside++
      }
      probe.frame = requestAnimationFrame(observe)
    }
    probe.frame = requestAnimationFrame(observe)
  }, anchor)
  return async () => page.evaluate(() => {
    const state = window as unknown as ReadingWindow
    const probe = state.acceptanceReadingProbe
    if (!probe) throw new Error('The reading observer was not installed')
    cancelAnimationFrame(probe.frame)
    delete state.acceptanceReadingProbe
    return probe.observation
  })
}

export function createReadingToolGate(profile: string) {
  const ready = join(profile, 'reading-tool-ready')
  const released = join(profile, 'reading-tool-released')
  const script = join(profile, 'reading-tool.cjs')
  writeFileSync(script, [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready')`,
    'const started = Date.now()',
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) { clearInterval(timer); process.stdout.write('READING_TOOL_RELEASED'); } else if (Date.now() - started > 45000) { clearInterval(timer); process.stderr.write('The reading test did not release its tool'); process.exitCode = 1; } }, 40)`,
  ].join('\n'))
  return {
    command: `"${process.execPath}" "${script}"`,
    started: () => existsSync(ready),
    release: () => writeFileSync(released, 'release'),
  }
}
