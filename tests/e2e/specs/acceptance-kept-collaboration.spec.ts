import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { buildTeamSessionKey } from '../../../src/shared/apps/im-keys'
import type { TeamConversation, TeamDetail, TeamMember, EpochBoard } from '../../../src/shared/apps/team-types'
import {
  test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation,
} from '../fixtures/acceptance-app'
import { collaboratorReceipt, hasRetiredDailyTeamTool, type CollaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { modelTool, type AcceptanceModel } from '../fixtures/acceptance-model'
import { openManagedConversation } from '../fixtures/acceptance-management'
import { navigateToApps, navigateToChat } from '../fixtures/helpers'

type StoredMessage = { id: string; role: string; content: string }
type Collaboration = {
  detail: TeamDetail
  task: TeamConversation
  source: Awaited<ReturnType<typeof readAcceptanceConversation>>
  spaceId: string
  members: TeamMember[]
  roles: Map<string, keyof typeof facts>
}

const startMessage = 'Prepare two reviewers for this collaboration. I will talk to each reviewer in the task room.'
const readyMessage = 'The two reviewers are ready in the original collaboration.'
const memberNames = ['Analyst', 'Reviewer'] as const
const facts = { Analyst: 'amber-718', Reviewer: 'violet-263' }

function scriptCollaboration(model: AcceptanceModel) {
  const resumed: Array<{ member: string; ownHistory: boolean; otherHistory: boolean }> = []
  const created = new Map<keyof typeof facts, CollaboratorReceipt>()
  const errors: string[] = []
  model.respond(request => {
    if (hasRetiredDailyTeamTool(request)) errors.push('A retired daily team tool was advertised.')
    const resume = request.lastUserText.match(/Continue our earlier discussion, (Analyst|Reviewer), without repeating my reference\./)
    if (resume) {
      const member = resume[1] as keyof typeof facts
      const other = member === 'Analyst' ? 'Reviewer' : 'Analyst'
      resumed.push({ member, ownHistory: request.text.includes(facts[member]), otherHistory: request.text.includes(facts[other]) })
      return { text: `${member} has received the continuation.` }
    }
    const remember = request.lastUserText.match(/Remember my private reference, (Analyst|Reviewer): ([a-z]+-\d+)\./)
    if (remember) return { text: `${remember[1]} recorded ${remember[2]} for this task.` }
    const introduction = request.lastUserText.match(/Confirm you are reachable after restart, ([^.]+)\./)
    if (introduction) return { text: `${introduction[1]} is reachable in the retained task.` }
    if (request.text.includes(startMessage)) {
      for (const member of memberNames) {
        const id = `create-${member}`
        const receipt = request.toolResults.find(result => result.id === id)
        if (!receipt) return { tools: [modelTool(request, 'spawn_agent', {
          name: member,
          prompt: `RETAINED_COLLABORATOR_${member}: Wait for the person to provide a review brief in this task. Do not publish private conversation contents.`,
        }, id)] }
        try { created.set(member, collaboratorReceipt(receipt)) }
        catch (error) { errors.push(String(error)); return { text: 'The reviewer could not be created.' } }
      }
      const ready = memberNames.every(member => request.text.includes(`RETAINED_READY_${member}`))
      return { text: ready ? (request.text.includes(readyMessage) ? 'Both reviewers remain available in the task room.' : readyMessage) : 'The reviewers are being prepared.' }
    }
    const pending = request.text.match(/RETAINED_COLLABORATOR_(Analyst|Reviewer)/)
    if (pending) return { text: `RETAINED_READY_${pending[1]}` }
    errors.push(`Unexpected retained-collaboration model request ${request.sequence}`)
    return { text: 'No matching fixture work.' }
  })
  return { resumed, created, errors }
}

type CollaborationScript = ReturnType<typeof scriptCollaboration>

async function readBoard(page: Page, teamId: string, epochId: string): Promise<EpochBoard> {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamEpochBoard(input), { teamId, epochId })
  expect(result.success).toBe(true)
  return result.data as EpochBoard
}

async function readDetail(page: Page, teamId: string): Promise<TeamDetail> {
  return page.evaluate(async id => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.teamGetDetail(id)
    if (!result.success || !result.data) throw new Error(`Could not read the retained team: ${result.error}`)
    return result.data as TeamDetail
  }, teamId)
}

async function readTasks(page: Page, teamId: string): Promise<TeamConversation[]> {
  return page.evaluate(async id => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.teamListConversations(id)
    if (!result.success) throw new Error(`Could not read the retained task: ${result.error}`)
    return result.data as TeamConversation[]
  }, teamId)
}

async function taskHistory(page: Page, task: { teamId: string; epochId: string; spaceId: string }, member: { appId: string }): Promise<StoredMessage[]> {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.teamChatMessages(input), {
    teamId: task.teamId, epochId: task.epochId, appId: member.appId, spaceId: task.spaceId,
  })
  expect(result.success, 'Read the real member transcript without replacing its storage').toBe(true)
  return (result.data as StoredMessage[]).map(({ id, role, content }) => ({ id, role, content }))
}

const memberHistory = (page: Page, collab: Collaboration, member: TeamMember) => taskHistory(page, { teamId: collab.detail.team.id, epochId: collab.task.epochId, spaceId: collab.spaceId }, member)

function teamHeader(page: Page, name: string) {
  return page.getByRole('heading', { name, exact: true, level: 1 }).locator('xpath=ancestor::header')
}

async function openSourceRoom(page: Page, name: string) {
  const label = page.getByText(`Team: ${name}`, { exact: true })
  await expect(label).toHaveCount(1)
  await label.locator('..').getByRole('button', { name: 'Open team view', exact: true }).click()
  await expect(teamHeader(page, name)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Task room', exact: true })).toBeVisible()
}

async function prepareCollaboration(page: Page, script: CollaborationScript): Promise<Collaboration> {
  await navigateToChat(page)
  const turn = await sendAcceptanceMessage(page, startMessage)
  await expect(page.locator('.message-assistant [data-message-content]').filter({ hasText: readyMessage })).toContainText(readyMessage, { timeout: 60000 })
  await waitForAcceptanceIdle(page, turn.conversationId)
  const source = await readAcceptanceConversation(page, turn.spaceId, turn.conversationId)
  const summary = await page.evaluate(async id => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id)
    if (!result.success || !result.data) throw new Error('The UI-created collaboration must have a persisted source association')
    return result.data as { teamId: string; epochId: string }
  }, turn.conversationId)
  const detail = await readDetail(page, summary.teamId)
  expect(detail.team).toMatchObject({ ephemeral: true, coordinatorConversationId: source.id })
  expect(script.errors).toEqual([])
  expect([...script.created.keys()].sort()).toEqual([...memberNames].sort())
  const members = (await readBoard(page, detail.team.id, summary.epochId)).members.filter(member => !member.isSystemCoordinator)
  expect(members.map(member => member.appId).sort()).toEqual([...script.created.values()].map(receipt => receipt.handle).sort())
  expect(members.map(member => member.memberName).sort()).toEqual([...script.created.values()].map(receipt => receipt.name).sort())
  const roles = new Map([...script.created].map(([role, receipt]) => [receipt.handle, role]))
  const tasks = await readTasks(page, detail.team.id)
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ epochId: summary.epochId, kind: 'collab', readonly: false })
  const directory = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.teamList())
  expect(directory.success).toBe(true)
  expect((directory.data as Array<{ id: string }>).some(team => team.id === detail.team.id)).toBe(false)
  await openSourceRoom(page, detail.team.name)
  return { detail, members, roles, task: tasks[0], source, spaceId: turn.spaceId }
}

interface SavedTeam { teamId: string; detail: TeamDetail }

async function keepCollaboration(page: Page, collab: Collaboration): Promise<SavedTeam> {
  await teamHeader(page, collab.detail.team.name).getByRole('button', { name: 'Keep this team', exact: true }).click()
  await expect(teamHeader(page, collab.detail.team.name).getByRole('button', { name: 'Open saved team', exact: true })).toBeVisible()
  await expect(teamHeader(page, collab.detail.team.name).getByRole('button', { name: 'Keep this team', exact: true })).toHaveCount(0)
  const original = await readDetail(page, collab.detail.team.id)
  expect(original.team.savedTeamId, 'Keeping must link the saved team to its collaboration').toBeTruthy()
  return { teamId: original.team.savedTeamId!, detail: await readDetail(page, original.team.savedTeamId!) }
}

async function expectOriginalIntact(page: Page, collab: Collaboration, saved: SavedTeam) {
  const current = await readDetail(page, collab.detail.team.id)
  expect(current.team).toMatchObject({ id: collab.detail.team.id, ephemeral: true, coordinatorConversationId: collab.source.id, leadAppId: collab.detail.team.leadAppId, savedTeamId: saved.teamId })
  expect(current.members.map(member => member.appId).sort()).toEqual(collab.detail.members.map(member => member.appId).sort())
  expect((await readBoard(page, collab.detail.team.id, collab.task.epochId)).members.map(member => member.appId).sort()).toEqual(collab.members.map(member => member.appId).sort())
  const tasks = await readTasks(page, collab.detail.team.id)
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ epochId: collab.task.epochId, kind: 'collab', readonly: false })
  const association = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), collab.source.id)
  expect(association).toMatchObject({ success: true, data: { teamId: collab.detail.team.id, epochId: collab.task.epochId, saved: true, savedTeamId: saved.teamId } })
}

/** Saving copies configuration into new identities, never the temporary actors' work. */
async function expectSavedTeam(page: Page, collab: Collaboration, saved: SavedTeam) {
  const current = await readDetail(page, saved.teamId)
  expect(current.team).toMatchObject({ id: saved.teamId, ephemeral: false })
  expect(current.team.id).not.toBe(collab.detail.team.id)
  expect(current.team.leadAppId).not.toBe(collab.detail.team.leadAppId)
  const directory = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.teamList())
  expect(directory.success).toBe(true)
  expect((directory.data as Array<{ id: string }>).some(team => team.id === collab.detail.team.id)).toBe(false)
  expect((directory.data as Array<{ id: string }>).some(team => team.id === saved.teamId)).toBe(true)
  const roster = current.members.map(member => member.appId)
  for (const member of collab.members) {
    expect(roster, 'A saved digital human must not take over a temporary identity').not.toContain(member.appId)
    const savedMember = current.members.find(candidate => candidate.memberName === member.memberName)
    expect(savedMember).toBeTruthy()
    const identities = await page.evaluate(async ({ temporary, permanent }) => {
      const api = (globalThis as unknown as { halo: HaloAPI }).halo
      return { temporary: await api.appGet(temporary), permanent: await api.appGet(permanent) }
    }, { temporary: member.appId, permanent: savedMember!.appId })
    expect(identities.temporary.data ?? null, 'Saving must not install the source temporary identity').toBeNull()
    expect(identities.permanent).toMatchObject({ success: true, data: { id: savedMember!.appId } })
  }
  expect(roster, 'The collaboration coordinator never joins the saved team').not.toContain(collab.detail.team.leadAppId)
  expect(await readTasks(page, saved.teamId)).toEqual([])
}

/** The conversation list shrinks to an icon rail while the canvas is open, so the canvas is collapsed first. */
async function openOriginalConversation(page: Page, collab: Collaboration) {
  await navigateToChat(page)
  const collapse = page.getByRole('button', { name: 'Collapse canvas', exact: true })
  if (await collapse.isVisible()) await collapse.click()
  await openManagedConversation(page, collab.source.title, collab.spaceId)
}

async function openOriginalTask(page: Page, collab: Collaboration) {
  await openOriginalConversation(page, collab)
  await openSourceRoom(page, collab.detail.team.name)
}

async function openSavedTeam(page: Page, saved: SavedTeam) {
  await navigateToApps(page)
  await page.getByRole('button', { name: 'Teams', exact: true }).click()
  const card = page.getByRole('button').filter({ has: page.getByRole('heading', { name: saved.detail.team.name, exact: true, level: 2 }) })
  await expect(card, 'Only the saved team is listed; the temporary collaboration stays out of the Teams page').toHaveCount(1)
  await card.click()
  await expect(teamHeader(page, saved.detail.team.name)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Task room', exact: true })).toBeVisible()
}

async function selectMember(page: Page, collab: Collaboration, member: TeamMember): Promise<Locator> {
  const select = page.getByRole('button', { name: `View ${member.memberName}’s work in this task`, exact: true })
  if (!await select.isVisible()) await teamHeader(page, collab.detail.team.name).getByRole('button', { name: 'Members', exact: true }).click()
  await select.click()
  const room = page.getByRole('region', { name: 'Task room', exact: true })
  await expect(room.locator('textarea')).toBeVisible()
  const target = room.getByRole('combobox', { name: 'Choose who to talk to', exact: true })
  if (await target.count()) await expect(target).toHaveValue(member.appId)
  else await expect(room.getByTitle(member.memberName, { exact: true })).toBeVisible()
  return room
}

async function sendInNewTask(page: Page, member: TeamMember, message: string, response: string) {
  const room = page.getByRole('region', { name: 'Task room', exact: true })
  const target = room.getByRole('combobox', { name: 'Choose who to talk to', exact: true })
  await expect(room.locator('textarea')).toBeVisible()
  await target.selectOption(member.appId)
  await expect(target).toHaveValue(member.appId)
  await room.locator('textarea').fill(message)
  await room.locator('textarea').press('Enter')
  const reply = room.locator('.message-assistant [data-message-content]').filter({ hasText: response })
  await expect(reply).toHaveCount(1, { timeout: 30000 })
  await expect(reply).toBeVisible()
}

async function sendToMember(page: Page, collab: Collaboration, member: TeamMember, message: string, response: string) {
  const room = await selectMember(page, collab, member)
  await room.locator('textarea').fill(message)
  await room.locator('textarea').press('Enter')
  await expect(room.locator('textarea')).toHaveValue('')
  const reply = room.locator('.message-assistant [data-message-content]').filter({ hasText: response })
  await expect(reply).toHaveCount(1, { timeout: 30000 })
  await expect(reply).toHaveText(response)
  await expect(reply).toBeVisible()
  await expect.poll(async () => {
    const result = await page.evaluate(({ appId, conversationId }) => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(appId, conversationId), {
      appId: member.appId, conversationId: buildTeamSessionKey(member.appId, collab.detail.team.id, collab.task.epochId),
    })
    expect(result.success).toBe(true)
    return (result.data as { isActive: boolean }).isActive
  }).toBe(false)
  await expect.poll(async () => (await memberHistory(page, collab, member)).filter(item => item.role === 'assistant' && item.content === response).length).toBe(1)
}

test('keeping a collaboration saves its members as a separate team, leaves the collaboration as it was, and every member of the saved team can chat on a new task after restart', acceptance('teams.collaboration.keep-existing'), async ({ model, acceptanceApp, window }, testInfo) => {
  test.setTimeout(240000)
  const script = scriptCollaboration(model)
  const collab = await prepareCollaboration(window, script)
  const saved = await keepCollaboration(window, collab)
  await expectOriginalIntact(window, collab, saved)
  await expectSavedTeam(window, collab, saved)
  const reopened = await acceptanceApp.restart()
  await expectOriginalIntact(reopened, collab, saved)
  await expectSavedTeam(reopened, collab, saved)
  await openSavedTeam(reopened, saved)
  const roster = (await readDetail(reopened, saved.teamId)).members
  const participants = roster.filter(member => member.appId === saved.detail.team.leadAppId || collab.members.some(candidate => candidate.memberName === member.memberName))
  expect(participants.length).toBe(collab.members.length + 1)
  for (const member of participants) {
    await sendInNewTask(reopened, member, `Confirm you are reachable after restart, ${member.memberName}.`, `${member.memberName} is reachable in the retained task.`)
  }
  const tasks = await readTasks(reopened, saved.teamId)
  expect(tasks).toHaveLength(1)
  for (const member of participants) {
    const history = await taskHistory(reopened, { teamId: saved.teamId, epochId: tasks[0].epochId, spaceId: collab.spaceId }, member)
    expect(history.filter(item => item.role === 'user').map(item => item.content)).toEqual([`Confirm you are reachable after restart, ${member.memberName}.`])
  }
  await expectOriginalIntact(reopened, collab, saved)
  for (const member of collab.members) expect(JSON.stringify(await memberHistory(reopened, collab, member))).not.toContain('reachable after restart')
  expect(script.errors).toEqual([])
  await testInfo.attach('saved-team', { body: JSON.stringify({ saved: await readDetail(reopened, saved.teamId), tasks, original: await readDetail(reopened, collab.detail.team.id) }, null, 2), contentType: 'application/json' })
})

test('keeping a collaboration leaves its original task, member histories and context readable and continuing after restart, and gives the saved team none of them', acceptance('teams.collaboration.keep-history'), async ({ model, acceptanceApp, window }, testInfo) => {
  test.setTimeout(240000)
  const script = scriptCollaboration(model)
  const { resumed } = script
  const collab = await prepareCollaboration(window, script)
  const before = new Map<string, StoredMessage[]>()
  for (const member of collab.members) {
    const role = collab.roles.get(member.appId)!
    const fact = facts[role]
    await sendToMember(window, collab, member, `Remember my private reference, ${role}: ${fact}.`, `${role} recorded ${fact} for this task.`)
    before.set(member.appId, await memberHistory(window, collab, member))
  }
  const saved = await keepCollaboration(window, collab)
  const reopened = await acceptanceApp.restart()
  await openOriginalTask(reopened, collab)
  await expectOriginalIntact(reopened, collab, saved)
  for (const member of collab.members) {
    expect(await memberHistory(reopened, collab, member)).toEqual(before.get(member.appId))
    const room = await selectMember(reopened, collab, member)
    const role = collab.roles.get(member.appId)!
    const fact = facts[role]
    const other = memberNames.find(name => name !== role)!
    await expect(room.locator('.message-assistant [data-message-content]').filter({ hasText: `${role} recorded ${fact} for this task.` })).toBeVisible()
    await expect(room.getByText(`${other} recorded ${facts[other]} for this task.`, { exact: true })).toHaveCount(0)
    await sendToMember(reopened, collab, member, `Continue our earlier discussion, ${role}, without repeating my reference.`, `${role} has received the continuation.`)
    const after = await memberHistory(reopened, collab, member)
    expect(after.slice(0, before.get(member.appId)!.length)).toEqual(before.get(member.appId))
    expect(after.length).toBeGreaterThan(before.get(member.appId)!.length)
    expect(JSON.stringify(after)).not.toContain(facts[other])
  }
  await expectOriginalIntact(reopened, collab, saved)
  await expectSavedTeam(reopened, collab, saved)
  await openOriginalConversation(reopened, collab)
  await expect(reopened.locator('.message-assistant [data-message-content]').filter({ hasText: readyMessage })).toContainText(readyMessage)
  expect((await readAcceptanceConversation(reopened, collab.spaceId, collab.source.id)).messages).toEqual(collab.source.messages)
  expect(script.errors).toEqual([])
  await testInfo.attach('retained-member-contexts', { body: JSON.stringify({ before: Object.fromEntries(before), resumed }, null, 2), contentType: 'application/json' })
  expect(resumed.sort((a, b) => a.member.localeCompare(b.member))).toEqual(memberNames.map(member => ({ member, ownHistory: true, otherHistory: false })))
})
