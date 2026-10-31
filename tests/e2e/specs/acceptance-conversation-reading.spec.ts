import { randomUUID } from 'node:crypto'
import { test as appTest, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from '../fixtures/acceptance-app'
import { test as managementTest, expect, managementAcceptance, openManagedConversation, readManagedConversation } from '../fixtures/acceptance-management'
import { createModelGate } from '../fixtures/acceptance-model'
import {
  assertHistoryWindow, createReadingToolGate, readHistoryWindow, readReadingAnchor, seedReadingConversation,
  settleReadingLayout, watchReadingAnchor, type ReadingAnchor, type ReadingObservation,
} from '../fixtures/acceptance-conversation-reading'

appTest.setTimeout(120000)

appTest('reading an older saved message stays anchored while a real tool releases a streamed reply', acceptance('conversations.read.anchor'), async ({ acceptanceApp, window, model }, info) => {
  const seeded = await seedReadingConversation(window, acceptanceApp.profile, 120, 'Read saved history during work')
  const reopened = await acceptanceApp.restart()
  await reopened.setViewportSize({ width: 1280, height: 800 })
  await openManagedConversation(reopened, seeded.conversation.title)
  expect(seeded.identities(await readManagedConversation(reopened, 'halo-temp', seeded.conversation.id))).toEqual(seeded.identities(seeded.conversation))
  const scroller = reopened.getByTestId('transcript-scroller')
  await expect.poll(async () => (await readHistoryWindow(scroller)).distanceToEnd).toBeLessThanOrEqual(2)
  const gate = createReadingToolGate(acceptanceApp.profile)
  const completion = createModelGate()
  const question = `Wait for the controlled reading operation ${randomUUID()}.`
  const ending = `Latest reply complete ${randomUUID()}`
  const reply = Array.from({ length: 18 }, (_, index) => `New reply paragraph ${index + 1}. This is actual streamed model output after the controlled tool returned. The reader should keep the old message in exactly the same place while this new content grows below it.`).join('\n\n') + `\n\n${ending}`
  const protocol: Array<{ sequence: number; advertisedBash: number; toolResult?: { error: boolean; released: boolean } }> = []
  model.respond(request => {
    const result = request.toolResults.find(result => result.id === 'reading-wait-tool')
    const tools = request.tools.filter(name => name === 'Bash' || name.endsWith('__Bash'))
    protocol.push({ sequence: request.sequence, advertisedBash: tools.length, ...(result ? { toolResult: { error: result.error, released: result.text.includes('READING_TOOL_RELEASED') } } : {}) })
    if (result) return { text: reply, hold: completion.promise }
    if (tools.length !== 1) return { text: 'The controlled reading tool was unavailable.' }
    return { tools: [{ id: 'reading-wait-tool', name: tools[0], input: { command: gate.command, timeout: 60000, run_in_background: false } }] }
  })
  let stopObserving: (() => Promise<ReadingObservation>) | undefined
  let anchor: ReadingAnchor | null = null
  let observation: ReadingObservation | undefined
  try {
    const turn = await sendAcceptanceMessage(reopened, question)
    expect(turn.conversationId).toBe(seeded.conversation.id)
    await expect.poll(gate.started, { timeout: 30000 }).toBe(true)
    await expect(reopened.getByTitle('Stop generation (Esc)', { exact: true })).toBeVisible()
    await scroller.hover()
    await reopened.mouse.wheel(0, -1200)
    await expect.poll(async () => (await readHistoryWindow(scroller)).distanceToEnd).toBeGreaterThan(500)
    let previous: ReadingAnchor | null = null
    let steady = 0
    await expect.poll(async () => {
      await settleReadingLayout(reopened)
      anchor = await readReadingAnchor(scroller)
      steady = anchor && previous?.messageId === anchor.messageId && Math.abs(previous.offset - anchor.offset) <= 0.5 ? steady + 1 : 0
      previous = anchor
      return steady
    }, { intervals: [50], timeout: 5000 }).toBeGreaterThanOrEqual(3)
    expect(anchor).not.toBeNull()
    expect(seeded.conversation.messages.some(message => message.id === anchor!.messageId)).toBe(true)
    const anchoredMessage = seeded.conversation.messages.find(message => message.id === anchor!.messageId)!
    const anchoredRow = scroller.locator(`[data-message-id="${anchoredMessage.id}"]`)
    await expect(anchoredRow).toContainText(anchoredMessage.content)
    const before = await readHistoryWindow(scroller)
    stopObserving = await watchReadingAnchor(reopened, anchor!)
    gate.release()
    await expect.poll(() => model.exchanges[1]?.reply?.text, { timeout: 30000 }).toBe(reply)
    await expect.poll(async () => (await readHistoryWindow(scroller)).height).toBeGreaterThan(before.height + 200)
    expect(model.exchanges[1].completed).toBe(false)
    await expect(reopened.getByTitle('Stop generation (Esc)', { exact: true })).toBeVisible()
    const during = await readReadingAnchor(scroller)
    expect(during?.messageId).toBe(anchor!.messageId)
    expect(Math.abs(during!.offset - anchor!.offset)).toBeLessThanOrEqual(2)
    await expect(anchoredRow).toContainText(anchoredMessage.content)

    completion.release()
    await waitForAcceptanceIdle(reopened, turn.conversationId)
    await settleReadingLayout(reopened)
    observation = await stopObserving()
    stopObserving = undefined
    expect(observation.samples).toBeGreaterThan(0)
    expect(observation.missing).toBe(0)
    expect(observation.outside).toBe(0)
    expect(observation.maximumDrift).toBeLessThanOrEqual(2)
    expect(protocol).toEqual([
      { sequence: 1, advertisedBash: 1 },
      { sequence: 2, advertisedBash: 1, toolResult: { error: false, released: true } },
    ])
    const stored = await readAcceptanceConversation(reopened, turn.spaceId, turn.conversationId)
    expect(stored.messages).toHaveLength(seeded.conversation.messages.length + 2)
    expect(stored.messages.slice(0, seeded.conversation.messages.length).map(({ id, role, content }) => ({ id, role, content }))).toEqual(seeded.identities(seeded.conversation))
    expect(stored.messages.at(-2)).toMatchObject({ role: 'user', content: question })
    expect(stored.messages.at(-1)).toMatchObject({ role: 'assistant', content: reply })
    expect(seeded.identities(seeded.readDisk())).toEqual(stored.messages.map(({ id, role, content }) => ({ id, role, content })))
    const jump = reopened.getByRole('button', { name: 'Scroll to latest message', exact: true })
    await expect(jump).toHaveCSS('opacity', '1')
    await jump.click()
    await expect.poll(async () => (await readHistoryWindow(scroller)).distanceToEnd).toBeLessThanOrEqual(2)
    await expect(scroller.getByText(ending, { exact: true })).toBeInViewport()
  } finally {
    gate.release()
    completion.release()
    if (stopObserving) observation = await stopObserving()
    await info.attach('stored-conversation-reading-anchor', { body: JSON.stringify({ conversationId: seeded.conversation.id, savedMessageCount: seeded.conversation.messages.length, anchor, observation, protocol }, null, 2), contentType: 'application/json' })
  }
})

const paginationTest = managementTest.extend({ trace: 'retain-on-failure' })

paginationTest('a stored ordinary conversation exposes every older message through bounded display windows', managementAcceptance('conversations.read.pagination'), async ({ managementApp, window }, info) => {
  const started = performance.now()
  const measurements: Array<{ phase: string; completed: boolean; milliseconds: number; elapsedMilliseconds: number }> = []
  let pendingPhase: string | null = null
  const measure = async <T,>(phase: string, action: () => T | Promise<T>): Promise<T> => {
    const began = performance.now()
    pendingPhase = phase
    let completed = false
    try {
      const result = await action()
      completed = true
      return result
    }
    finally {
      measurements.push({ phase, completed, milliseconds: performance.now() - began, elapsedMilliseconds: performance.now() - started })
      if (completed) pendingPhase = null
    }
  }
  const windows: Array<{ first: number; last: number; liveRows: number; placeholders: number; top: number; visibleMessageIds: string[]; elapsedMilliseconds: number; sampleMilliseconds: number }> = []
  const visited = new Set<string>()
  const visible = new Set<string>()
  let saved: Awaited<ReturnType<typeof seedReadingConversation>> | undefined
  let lastSnapshot: Awaited<ReturnType<typeof readHistoryWindow>> | undefined
  try {
    const seeded = await measure('seed-persistent-history', () => seedReadingConversation(window, managementApp.profile, 420, 'Read all saved history'))
    saved = seeded
    const reopened = await measure('restart-application', () => managementApp.restart())
    await measure('set-viewport', () => reopened.setViewportSize({ width: 1280, height: 800 }))
    await measure('open-stored-conversation', () => openManagedConversation(reopened, seeded.conversation.title))
    await measure('verify-reloaded-history', async () => {
      expect(seeded.identities(await readManagedConversation(reopened, 'halo-temp', seeded.conversation.id))).toEqual(seeded.identities(seeded.conversation))
    })
    const scroller = reopened.getByTestId('transcript-scroller')
    await measure('initial-follow-latest', () => expect.poll(async () => (await readHistoryWindow(scroller)).distanceToEnd).toBeLessThanOrEqual(2))
    const observe = async () => {
      const snapshot = await measure('read-rendered-window', () => readHistoryWindow(scroller))
      lastSnapshot = snapshot
      windows.push({ first: snapshot.rows[0]?.index ?? -1, last: snapshot.rows.at(-1)?.index ?? -1, liveRows: snapshot.rows.length, placeholders: snapshot.placeholders, top: snapshot.top, visibleMessageIds: snapshot.visibleMessageIds, elapsedMilliseconds: performance.now() - started, sampleMilliseconds: snapshot.sampleMilliseconds })
      await measure('assert-rendered-window', () => {
        for (const id of assertHistoryWindow(snapshot, seeded)) visited.add(id)
        for (const id of snapshot.visibleMessageIds) visible.add(id)
      })
      return snapshot
    }
    const initial = await observe()
    expect(initial.rows.length).toBeLessThan(seeded.conversation.messages.length)
    expect(initial.rows.at(-1)!.index).toBe(seeded.conversation.messages.length - 1)
    let current = initial
    await measure('hover-transcript', () => scroller.hover())
    for (let step = 0; step < 500 && (current.rows[0].index !== 0 || current.top > 2); step++) {
      await measure('mouse-wheel', () => reopened.mouse.wheel(0, -Math.max(160, Math.floor(current.viewport * 0.55))))
      await measure('settle-layout', () => settleReadingLayout(reopened))
      current = await observe()
    }
    expect(current.rows[0].index, 'The actual oldest message must be reachable with the mouse wheel').toBe(0)
    expect(current.top).toBeLessThanOrEqual(2)
    expect(visited.size).toBe(seeded.conversation.messages.length)
    expect([...visited].sort()).toEqual(seeded.conversation.messages.map(message => message.id).sort())
    expect([...visible].sort(), 'Every stored message must actually intersect the reading viewport during the mouse traversal').toEqual(seeded.conversation.messages.map(message => message.id).sort())
    expect(windows.some(value => value.placeholders > 0), 'Reading beyond the live cap must retire distant message components').toBe(true)
    await expect(scroller.locator(`[data-message-id="${seeded.conversation.messages[0].id}"]`)).toBeInViewport()
    const jump = reopened.getByRole('button', { name: 'Scroll to latest message', exact: true })
    await expect(jump).toHaveCSS('opacity', '1')
    await measure('jump-to-latest', async () => {
      await jump.click()
      await expect.poll(async () => (await readHistoryWindow(scroller)).distanceToEnd).toBeLessThanOrEqual(2)
    })
    const returned = await observe()
    expect(returned.rows.at(-1)!.index).toBe(seeded.conversation.messages.length - 1)
    await expect(scroller.locator(`[data-message-id="${seeded.conversation.messages.at(-1)!.id}"]`)).toBeInViewport()
    expect(seeded.identities(await readManagedConversation(reopened, 'halo-temp', seeded.conversation.id))).toEqual(seeded.identities(seeded.conversation))
    expect(seeded.identities(seeded.readDisk())).toEqual(seeded.identities(seeded.conversation))
  } finally {
    await info.attach('stored-conversation-display-windows', { body: JSON.stringify({ conversationId: saved?.conversation.id, savedMessageCount: saved?.conversation.messages.length, mountedMessageIds: [...visited], visibleMessageIds: [...visible], pendingPhase, measurements, windows, lastSnapshot }, null, 2), contentType: 'application/json' })
  }
})
