/**
 * A temporary space collaboration, opened the way a person opens one: from the
 * collaboration card in the space conversation that coordinates it.
 *
 * It has exactly one conversation — the room its coordinator talks to the team
 * in — so the workbench shows that room and offers no task list, no way to open
 * a second conversation, and no way to create one. The seeded profile is a real
 * collaboration (see fixtures/team-collab.ts), so the room below is projected by
 * the same code that runs for a user.
 */

import { test, expect, COLLAB_CONVERSATION_TITLE, COLLAB_MEMBER_NAME, COLLAB_TEAM_NAME } from '../fixtures/team-collab'
import { waitForHomePage } from '../fixtures/helpers'

test.setTimeout(60000)

test.describe('repaired collaboration history', () => {
  test.use({ legacySaved: true })

  test('desktop IPC refuses every new input to the unsealed source task while retaining reads and stops', async ({ window, collaboration }) => {
    await waitForHomePage(window)
    const result = await window.evaluate(async ({ teamId, roomId, memberAppId }) => {
      const api = (window as any).halo
      const detail = await api.teamGetDetail(teamId)
      const tasks = (await api.teamListConversations(teamId)).data
      const conversationId = `app-chat:${memberAppId}:team:${teamId}:${roomId}`
      const input = { appId: memberAppId, spaceId: 'halo-temp', conversationId, message: 'Must not start new work' }
      const sends = [
        await api.appChatSend(input),
        await api.appChatInject(input),
        await api.teamSendToMember({ teamId, appId: memberAppId, epochId: roomId, message: input.message }),
      ]
      const history = await api.appChatTranscript(input)
      const stop = await api.appChatStop(memberAppId, conversationId)
      const memberStop = await api.teamStopMember({ teamId, appId: memberAppId, epochId: roomId })
      const newTask = await api.teamOpenConversation({ teamId, title: 'Independent new work' })
      return { detail, tasks, sends, history, stop, memberStop, newTask }
    }, collaboration)
    expect(result.detail.success).toBe(true)
    expect(result.detail.data.legacyCoordinator).toBeUndefined()
    expect(result.tasks.find((task: { epochId: string }) => task.epochId === collaboration.roomId)?.readonly).toBe(true)
    for (const response of result.sends) expect(response).toMatchObject({ success: false, error: 'This task is read-only.' })
    expect(result.history.success).toBe(true)
    expect(result.history.data.messages).toEqual([])
    expect(result.stop.success).toBe(true)
    expect(result.memberStop.success).toBe(true)
    expect(result.newTask.success).toBe(true)
    expect(result.newTask.data.epochId).not.toBe(collaboration.roomId)
  })
})

test('keeping a team saves its configuration without transferring the current task', async ({ window, collaboration }) => {
  await waitForHomePage(window)
  await window.getByText(COLLAB_CONVERSATION_TITLE, { exact: true }).first().click()
  await window.getByRole('button', { name: 'Open team view', exact: true }).click()
  await expect(window.getByRole('button', { name: 'View coordinator’s work in this task', exact: true })).toHaveCount(0)
  await window.getByRole('button', { name: 'Keep this team', exact: true }).click()
  const savedLink = window.getByRole('button', { name: 'Open saved team', exact: true })
  await expect(savedLink).toBeVisible()
  await expect(window.getByText('Temporary collaboration', { exact: true })).toBeVisible()
  await expect(window.getByRole('navigation', { name: 'Tasks', exact: true })).toHaveCount(0)

  const saved = await window.evaluate(async teamId => {
    const api = (window as any).halo
    const original = (await api.teamGetDetail(teamId)).data
    const result = (await api.teamGetDetail(original.team.savedTeamId)).data
    const tasks = (await api.teamListConversations(result.team.id)).data
    return { sourceId: original.team.id, sourceTemporary: original.team.ephemeral, sourceLead: original.team.leadAppId,
      savedId: result.team.id, savedTemporary: result.team.ephemeral, lead: result.team.leadAppId,
      members: result.members.map((member: { appId: string }) => member.appId), taskCount: tasks.length }
  }, collaboration.teamId)
  expect(saved.sourceTemporary).toBe(true)
  expect(saved.savedTemporary).toBe(false)
  expect(saved.savedId).not.toBe(saved.sourceId)
  expect(saved.members).not.toContain(saved.sourceLead)
  expect(saved.members).toContain(collaboration.memberAppId)
  expect(saved.taskCount).toBe(0)
  expect(saved.lead).not.toBe(saved.sourceLead)

  await savedLink.click()
  const room = window.getByRole('region', { name: 'Task room' })
  await expect(room.getByRole('heading', { name: 'New task', exact: true })).toBeVisible()
  await expect(room.getByRole('combobox', { name: 'Choose which of your digital humans to talk to' })).toHaveValue(saved.lead)
  await window.screenshot({ path: 'tests/e2e/results/team-saved-configuration.png' })
  await window.setViewportSize({ width: 375, height: 812 })
  await expect(room.locator('textarea')).toBeVisible()
  await expect.poll(() => room.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= innerWidth + 1
  })).toBe(true)
  await expect(room.getByRole('heading', { name: 'Start a new task', exact: true })).toBeInViewport()
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await window.screenshot({ path: 'tests/e2e/results/team-saved-configuration-mobile.png' })
})

test('a collaboration is one room: no task list, no task to create', async ({ window }) => {
  await waitForHomePage(window)

  await window.getByText(COLLAB_CONVERSATION_TITLE, { exact: true }).first().click()
  const openTeamView = window.getByRole('button', { name: 'Open team view', exact: true })
  await expect(openTeamView).toBeVisible()
  await expect(window.getByText(`Team: ${COLLAB_TEAM_NAME}`, { exact: true })).toBeVisible()

  await openTeamView.click()

  // The collaboration's workbench: the one action it offers is keeping the team.
  const room = window.getByRole('region', { name: 'Task room' })
  await expect(room).toBeVisible()
  await expect(window.getByText('Temporary collaboration', { exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Keep this team', exact: true })).toBeVisible()
  await expect(room.getByText(COLLAB_MEMBER_NAME, { exact: true }).first()).toBeVisible()

  // A collaboration has one conversation, so there is no task list to search,
  // filter, pick from or create into — and no drawer holding one at narrow
  // widths. (Distinct from the app's own "Tasks" rail panel, which is unrelated.)
  await expect(window.getByRole('navigation', { name: 'Tasks', exact: true })).toHaveCount(0)
  await expect(window.getByRole('searchbox', { name: 'Search tasks' })).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'New task', exact: true })).toHaveCount(0)
  await window.screenshot({ path: 'tests/e2e/results/team-collab-desktop.png' })

  // The members stay reachable: the rail at desktop width, the drawer below it.
  await window.setViewportSize({ width: 375, height: 812 })
  await expect(window.getByRole('dialog', { name: 'Tasks', exact: true })).toHaveCount(0)
  await expect(room.getByText(COLLAB_MEMBER_NAME, { exact: true }).first()).toBeVisible()
  await expect.poll(() => room.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= innerWidth + 1
  })).toBe(true)
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy()
  await window.screenshot({ path: 'tests/e2e/results/team-collab-mobile.png' })
  await window.getByRole('button', { name: 'Members', exact: true }).click()
  await expect(window.getByRole('dialog', { name: 'Members' })).toBeVisible()
})
