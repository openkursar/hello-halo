import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../src/shared/types/im-channel'
import {
  test, expect, acceptance, openAutomation, readAutomationActivity, startAutomation, waitForAutomationResult,
} from '../fixtures/acceptance-automation'
import { startAcceptanceWecom, type AcceptanceWecom } from '../fixtures/acceptance-wecom'
import { openManagedPersonSettings } from '../fixtures/acceptance-management'
import type { ModelRequest, ModelReply } from '../fixtures/acceptance-model'

test.setTimeout(240000)

const TEAM = ['acceptance-run-team-1', 'acceptance-run-team-2', 'acceptance-run-team-3', 'acceptance-run-team-4']
const OTHERS = ['acceptance-run-other-1', 'acceptance-run-other-2', 'acceptance-run-other-3', 'acceptance-run-other-4', 'acceptance-run-other-5', 'acceptance-run-other-6']
const CONTACTS = [...TEAM, ...OTHERS]
const PICKED = 'acceptance-run-other-1'
const GREETING = 'Register this contact for scheduled run results.'
const GREETING_REPLY = 'This contact is registered.'
const BARRIER = 'Confirm the channel is still answering.'
const BARRIER_REPLY = 'The channel is still answering.'
const OPTION = 'Send scheduled task results here'
const OPTION_NOTE = 'After each successful scheduled or background run, its final result is sent to this chat. Replies to messages are not affected.'
const ONLY_ON_PROBLEM = 'Message me only if the check finds a problem.'

async function sessions(page: Page, appId: string): Promise<ImSessionRecord[]> {
  const result = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.imSessionsList(id), appId)
  expect(result.success).toBe(true)
  return (result.data as ImSessionRecord[]).filter(session => session.channel === 'wecom-bot' && CONTACTS.includes(session.chatId))
}

async function persistedRecipients(page: Page, appId: string): Promise<string[]> {
  return (await sessions(page, appId)).filter(session => session.proactive).map(session => session.chatId).sort()
}

function pushes(wecom: AcceptanceWecom, after: number) {
  return wecom.replies.filter(reply => reply.index >= after && reply.command === 'aibot_send_msg')
}

async function contactsList(page: Page, appName: string) {
  await openManagedPersonSettings(page, appName)
  const section = page.locator('#settings-group-notifications')
  await section.scrollIntoViewIfNeeded()
  await expect(section.getByText('Reachable Contacts', { exact: true })).toBeVisible()
  const count = section.getByText(/^\d+ of \d+ get scheduled run results$/)
  await expect(count).toHaveCount(1)
  const bar = count.locator('xpath=..')
  return {
    section,
    count,
    selectAll: bar.getByRole('button', { name: 'Select all', exact: true }),
    clear: bar.getByRole('button', { name: 'Clear', exact: true }),
    search: section.getByPlaceholder('Search contacts', { exact: true }),
    row: (chatId: string): Locator => section.locator('div.group\\/contact').filter({ has: page.getByText(chatId, { exact: true }) }),
  }
}

test('run results reach only the chosen chats, and an only-on-a-problem run sends nothing', acceptance('notifications.delivery.run-result-recipients'), async ({ automation, model }, info) => {
  const wecom = await startAcceptanceWecom()
  try {
    const firstResult = `Scheduled check finished ${randomUUID()}`
    const secondResult = `Scheduled check found no problem ${randomUUID()}`
    const runRequests: ModelRequest[] = []
    let runPhase: 'first' | 'second' = 'first'

    model.respond((request): ModelReply => {
      if (request.lastUserText.includes(GREETING)) return { text: GREETING_REPLY }
      if (request.lastUserText.includes(BARRIER)) return { text: BARRIER_REPLY }
      const reported = request.toolResults.find(result => result.id === `report-${runPhase}`)
      if (reported) {
        expect(reported.error).toBe(false)
        return { text: runPhase === 'first' ? firstResult : secondResult }
      }
      runRequests.push(request)
      const report = request.tools.filter(tool => tool === 'report_to_user' || tool.endsWith('__report_to_user'))
      expect(report).toHaveLength(1)
      const message = runPhase === 'first' ? firstResult : secondResult
      return { tools: [{ id: `report-${runPhase}`, name: report[0], input: { type: 'run_complete', message } }] }
    })

    let page = automation.session.window
    const instance: ImChannelInstanceConfig = {
      id: `acceptance-instance-${randomUUID()}`, type: 'wecom-bot', enabled: false, appId: automation.appId,
      config: { botId: wecom.botId, secret: wecom.secret, wsUrl: wecom.url, nameResolveUrl: '', quoteReply: true },
      replyScope: 'all', permissionEnabled: false, owners: [], streaming: false, processingNotice: false,
    }
    const added = await page.evaluate(value => (globalThis as unknown as { halo: HaloAPI }).halo.imChannelsCreateInstance(value), instance)
    expect(added.success).toBe(true)
    page = await automation.session.restart()
    const enabled = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.imChannelsUpdateInstance(id, { enabled: true }), instance.id)
    expect(enabled.success).toBe(true)
    await expect.poll(async () => {
      const status = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.imChannelsInstanceStatus(id), instance.id)
      return status.success && (status.data as { connected?: boolean } | undefined)?.connected === true
    }, { timeout: 30000 }).toBe(true)
    await wecom.awaitAuthenticated()

    for (const chatId of CONTACTS) {
      const sent = await wecom.sendText({ senderId: chatId, senderName: chatId, chatId, chatType: 'direct', text: GREETING })
      await wecom.waitForReply({ requestId: sent.requestId, contains: GREETING_REPLY })
    }
    await expect.poll(async () => (await sessions(page, automation.appId)).map(session => session.chatId).sort()).toEqual([...CONTACTS].sort())
    expect(await persistedRecipients(page, automation.appId)).toEqual([])

    const list = await contactsList(page, automation.name)
    await expect(list.section.getByText('Tick a contact to send it the result of every scheduled run. To hear only when something needs attention, leave it unticked and say so in the instructions, for example "message me only if the check finds a problem"; with IM Push on, the digital human sends that message itself.', { exact: true })).toBeVisible()
    for (const chatId of CONTACTS) {
      const row = list.row(chatId)
      await expect(row).toHaveCount(1)
      await expect(row.locator('label').getByText(OPTION, { exact: true })).toBeVisible()
      await expect(row.locator('label').getByText(OPTION_NOTE, { exact: true })).toBeVisible()
      await expect(row.getByRole('checkbox')).not.toBeChecked()
    }
    await expect(list.count).toHaveText('0 of 10 get scheduled run results')
    await expect(list.selectAll).toBeEnabled()
    await expect(list.clear).toBeDisabled()

    await list.row(PICKED).getByRole('checkbox').check()
    await expect(list.count).toHaveText('1 of 10 get scheduled run results')
    await expect.poll(() => persistedRecipients(page, automation.appId)).toEqual([PICKED])

    await list.search.fill('run-team')
    for (const chatId of OTHERS) await expect(list.row(chatId)).toHaveCount(0)
    for (const chatId of TEAM) await expect(list.row(chatId)).toHaveCount(1)
    await expect(list.count).toHaveText('0 of 4 get scheduled run results')
    await expect(list.clear).toBeDisabled()
    await list.selectAll.click()
    await expect(list.count).toHaveText('4 of 4 get scheduled run results')
    await expect(list.selectAll).toBeDisabled()
    await expect(list.clear).toBeEnabled()
    for (const chatId of TEAM) await expect(list.row(chatId).getByRole('checkbox')).toBeChecked()
    await list.search.fill('')
    await expect(list.count).toHaveText('5 of 10 get scheduled run results')
    const chosen = [...TEAM, PICKED].sort()
    await expect.poll(() => persistedRecipients(page, automation.appId)).toEqual(chosen)
    for (const chatId of OTHERS.filter(chatId => chatId !== PICKED)) await expect(list.row(chatId).getByRole('checkbox')).not.toBeChecked()

    const beforeFirst = wecom.replies.length
    await openAutomation(page, automation)
    const first = await startAutomation(page, automation.appId)
    await waitForAutomationResult(page, automation.appId, first.runId, 'ok')
    for (const chatId of chosen) await wecom.waitForReply({ chatId, after: beforeFirst, contains: firstResult })
    const firstEntry = (await readAutomationActivity(page, automation.appId)).find(entry => entry.runId === first.runId && entry.type === 'run_complete')
    expect(firstEntry, 'The first run must leave a completion record').toBeTruthy()
    const firstBarrier = await wecom.sendText({ senderId: OTHERS[1], senderName: OTHERS[1], chatId: OTHERS[1], chatType: 'direct', text: BARRIER })
    await wecom.waitForReply({ requestId: firstBarrier.requestId, contains: BARRIER_REPLY })
    const firstPushes = pushes(wecom, beforeFirst)
    expect(firstPushes.map(reply => reply.chatId).sort()).toEqual(chosen)
    for (const reply of firstPushes) expect(reply.text).toContain(firstResult)
    expect(wecom.replies.slice(beforeFirst).filter(reply => reply.text.includes(firstResult) && !chosen.includes(reply.chatId))).toEqual([])

    const cleared = await contactsList(page, automation.name)
    await expect(cleared.count).toHaveText('5 of 10 get scheduled run results')
    await cleared.search.fill('run-team')
    await expect(cleared.count).toHaveText('4 of 4 get scheduled run results')
    await cleared.clear.click()
    await expect(cleared.count).toHaveText('0 of 4 get scheduled run results')
    await expect(cleared.clear).toBeDisabled()
    await cleared.search.fill('')
    await expect(cleared.count).toHaveText('1 of 10 get scheduled run results')
    await expect.poll(() => persistedRecipients(page, automation.appId)).toEqual([PICKED])
    await cleared.clear.click()
    await expect(cleared.count).toHaveText('0 of 10 get scheduled run results')
    await expect(cleared.clear).toBeDisabled()
    await expect.poll(() => persistedRecipients(page, automation.appId)).toEqual([])

    const instructions = `Run the local acceptance check. ${ONLY_ON_PROBLEM} Use report_to_user when the check is complete.`
    const updated = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateSpec(input), { appId: automation.appId, specPatch: { system_prompt: instructions } })
    expect(updated.success).toBe(true)

    runPhase = 'second'
    const runRequestsBefore = runRequests.length
    const beforeSecond = wecom.replies.length
    await openAutomation(page, automation)
    const second = await startAutomation(page, automation.appId)
    await waitForAutomationResult(page, automation.appId, second.runId, 'ok')
    const secondEntry = (await readAutomationActivity(page, automation.appId)).find(entry => entry.runId === second.runId && entry.type === 'run_complete')
    expect(secondEntry, 'The second run must leave a completion record').toBeTruthy()
    const secondRun = runRequests.slice(runRequestsBefore)
    expect(secondRun).toHaveLength(1)
    expect(secondRun[0].text).toContain(ONLY_ON_PROBLEM)
    expect(secondRun[0].tools.some(tool => tool.endsWith('__notify_bot')), 'An unticked contact stays reachable when a problem is found').toBe(true)
    const secondBarrier = await wecom.sendText({ senderId: OTHERS[2], senderName: OTHERS[2], chatId: OTHERS[2], chatType: 'direct', text: BARRIER })
    await wecom.waitForReply({ requestId: secondBarrier.requestId, after: beforeSecond, contains: BARRIER_REPLY })
    expect(pushes(wecom, beforeSecond)).toEqual([])
    expect(wecom.replies.slice(beforeSecond).filter(reply => reply.text.includes(secondResult))).toEqual([])
  } finally {
    await wecom.close()
    await info.attach('local-wecom-replies', { body: JSON.stringify(wecom.replies, null, 2), contentType: 'application/json' })
    expect(wecom.errors, 'Only the declared local WeCom protocol may be used').toEqual([])
  }
})
