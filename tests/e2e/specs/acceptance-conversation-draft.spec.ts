import { test, expect, readManagedConversation } from '../fixtures/acceptance-management'
import {
  assertDraftHistoryFiles, delayDraftHistoryDelivery, prepareDraftHistories, readNativeDraftHistory,
  type DraftReadReceipt, type DraftSession,
} from '../fixtures/acceptance-draft-loading'
import { openDigitalHumanConversation } from '../fixtures/helpers'

test.setTimeout(90000)

test('two person-conversation drafts stay separate when saved history arrives after switching conversations', {
  annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'conversations.read.draft', evidence: 'ui', mode: 'none', variant: {} }) },
}, async ({ managementApp, window }, info) => {
  await window.setViewportSize({ width: 1280, height: 800 })
  const world = await prepareDraftHistories(window, managementApp.profile)
  const [alpha, beta] = world.sessions
  const draftA = 'Alpha draft entered before its history arrives.'
  const draftB = 'Beta draft belongs only to the second conversation.'
  const suffixA = ' Alpha remains editable.'
  const suffixB = ' Beta remains editable.'
  const gate = await delayDraftHistoryDelivery(window, world.person.id, world.sessions.map(session => session.conversationId))
  const observations: Array<Record<string, unknown>> = []
  let finalReceipts: DraftReadReceipt[] | undefined

  const appendToDraft = async (text: string) => {
    const composer = window.locator('textarea').first()
    const length = (await composer.inputValue()).length
    await composer.press('ControlOrMeta+A')
    await composer.press('ArrowRight')
    expect(await composer.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))).toEqual({ start: length, end: length })
    await window.keyboard.insertText(text)
  }

  const waitForHeldRead = async (session: DraftSession) => {
    await expect.poll(async () => (await gate.read()).find(receipt => receipt.conversationId === session.conversationId && receipt.held)).toMatchObject({ nativeCompleted: true, nativeSuccess: true, delivered: false })
    const receipt = (await gate.read()).find(receipt => receipt.conversationId === session.conversationId && receipt.held)!
    expect(receipt.messageIds).toEqual(session.messages.map(message => message.id))
    await expect(window.getByText('Loading conversation...', { exact: true })).toBeVisible()
    await expect(window.getByTitle(`Chatting with ${world.person.spec.name}`, { exact: true })).toBeVisible()
    await expect(window.locator('textarea').first()).toBeEditable()
    for (const message of session.messages) await expect(window.getByTestId('transcript-scroller').getByText(message.content, { exact: true })).toHaveCount(0)
    observations.push({ phase: 'held-native-result', label: session.label, receipt })
  }

  const expectHistory = async (session: DraftSession, other: DraftSession, draft: string) => {
    await expect(window.getByText('Loading conversation...', { exact: true })).toHaveCount(0)
    for (const message of session.messages) {
      await expect(window.locator(`[data-message-id="${message.id}"]`).first()).toContainText(message.content)
    }
    for (const message of other.messages) await expect(window.getByTestId('transcript-scroller').getByText(message.content, { exact: true })).toHaveCount(0)
    await expect(window.locator('textarea').first()).toHaveValue(draft)
    await expect(window.locator('textarea').first()).toBeEditable()
    observations.push({ phase: 'shown-history-and-draft', conversationId: session.conversationId, draft })
  }

  try {
    await openDigitalHumanConversation(window, world.person.spec.name, alpha.label)
    await waitForHeldRead(alpha)
    await expect(window.locator('textarea').first()).toHaveValue('')
    await window.locator('textarea').first().fill(draftA)
    await expect(window.locator('textarea').first()).toHaveValue(draftA)

    await openDigitalHumanConversation(window, world.person.spec.name, beta.label)
    await waitForHeldRead(beta)
    await expect(window.locator('textarea').first()).toHaveValue('')
    await window.locator('textarea').first().fill(draftB)
    await expect(window.locator('textarea').first()).toHaveValue(draftB)
    expect((await gate.read()).filter(receipt => receipt.held && !receipt.delivered)).toHaveLength(2)

    await gate.release(alpha.conversationId)
    await expect.poll(async () => (await gate.read()).find(receipt => receipt.conversationId === alpha.conversationId && receipt.held)?.delivered).toBe(true)
    await window.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(window.locator('textarea').first()).toHaveValue(draftB)
    await expect(window.getByText('Loading conversation...', { exact: true })).toBeVisible()
    for (const message of alpha.messages) await expect(window.getByTestId('transcript-scroller').getByText(message.content, { exact: true })).toHaveCount(0)
    expect((await gate.read()).find(receipt => receipt.conversationId === beta.conversationId && receipt.held)?.delivered).toBe(false)
    observations.push({ phase: 'alpha-arrived-while-beta-selected', draft: await window.locator('textarea').first().inputValue() })

    await gate.release(beta.conversationId)
    await expect.poll(async () => (await gate.read()).find(receipt => receipt.conversationId === beta.conversationId && receipt.held)?.delivered).toBe(true)
    await expectHistory(beta, alpha, draftB)
    await appendToDraft(suffixB)
    await expect(window.locator('textarea').first()).toHaveValue(draftB + suffixB)

    await openDigitalHumanConversation(window, world.person.spec.name, alpha.label)
    await expectHistory(alpha, beta, draftA)
    await appendToDraft(suffixA)
    await expect(window.locator('textarea').first()).toHaveValue(draftA + suffixA)
    await openDigitalHumanConversation(window, world.person.spec.name, beta.label)
    await expectHistory(beta, alpha, draftB + suffixB)
    await openDigitalHumanConversation(window, world.person.spec.name, alpha.label)
    await expectHistory(alpha, beta, draftA + suffixA)

    for (const session of world.sessions) expect(await readNativeDraftHistory(window, session)).toEqual(session.messages)
    expect((await readManagedConversation(window, 'halo-temp', world.control.id)).messages).toEqual(world.control.messages)
    assertDraftHistoryFiles(world.sessions)
    await expect.poll(async () => (await gate.read()).every(receipt => receipt.nativeSuccess && receipt.nativeCompleted && receipt.delivered && !receipt.error)).toBe(true)
    finalReceipts = await gate.read()
    expect(finalReceipts.filter(receipt => receipt.held)).toHaveLength(2)
    expect(finalReceipts.every(receipt => receipt.nativeSuccess && receipt.nativeCompleted && receipt.delivered && !receipt.error)).toBe(true)
  } finally {
    try { if (!window.isClosed()) finalReceipts = await gate.restore() }
    finally { await info.attach('draft-history-delivery', { body: JSON.stringify({ boundary: 'ui: actual native reads with renderer-result delivery delayed', appId: world.person.id, sessions: world.sessions.map(session => ({ conversationId: session.conversationId, label: session.label, messageIds: session.messages.map(message => message.id) })), observations, finalReceipts }, null, 2), contentType: 'application/json' }) }
  }
})
