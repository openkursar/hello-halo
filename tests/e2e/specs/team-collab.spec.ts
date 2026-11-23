/**
 * An older collaboration with installed members, opened the way a person opens one: from the
 * collaboration card in the space conversation that coordinates it.
 *
 * It has exactly one conversation — the room its coordinator talks to the team
 * in — so the workbench shows that room and offers no task list, no way to open
 * a second conversation, and no way to create one. The seeded profile is a real
 * collaboration (see fixtures/team-collab.ts), so the room below is projected by
 * the same code that runs for a user.
 */

import { test, expect, COLLAB_CONVERSATION_TITLE, COLLAB_MEMBER_NAME, COLLAB_TEAM_NAME } from '../fixtures/team-collab'
import { setTheme, waitForHomePage } from '../fixtures/helpers'

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

test('keeping an older collaboration reuses its installed members without transferring the current task', async ({ window, collaboration }) => {
  await waitForHomePage(window)
  await window.getByText(COLLAB_CONVERSATION_TITLE, { exact: true }).first().click()
  await window.getByRole('button', { name: 'View team', exact: true }).click()
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
  await expect(room.getByRole('combobox', { name: 'Choose who to talk to' })).toHaveValue(saved.lead)
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

test('a collaboration is one room: no task list, no task to create', { annotation: { type: 'acceptance', description: "{\"caseId\":\"teams.collaboration.single-room\",\"evidence\":\"app-e2e\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
  await waitForHomePage(window)

  await window.getByText(COLLAB_CONVERSATION_TITLE, { exact: true }).first().click()
  const openTeamView = window.getByRole('button', { name: 'View team', exact: true })
  await expect(openTeamView).toBeVisible()
  await expect(window.getByRole('group', { name: COLLAB_TEAM_NAME, exact: true })).toBeVisible()

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

for (const width of [1280, 390]) {
  test(`the chat shows its team as one line that opens the full team (${width}px)`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'chat.work-history.team-summary', evidence: 'app-e2e', mode: 'none', variant: { viewport: String(width) } }) } }, async ({ window }) => {
    await waitForHomePage(window)
    await window.getByText(COLLAB_CONVERSATION_TITLE, { exact: true }).first().click()
    await window.setViewportSize({ width, height: 844 })

    const summary = window.getByRole('group', { name: COLLAB_TEAM_NAME, exact: true })
    await expect(summary).toBeVisible()
    await expect(summary).toContainText(/\d+ members?, (\d+ working|finished)/)
    // The roster belongs to the team view, not to the chat.
    await expect(summary).not.toContainText(COLLAB_MEMBER_NAME)
    const box = await summary.boundingBox()
    expect(box!.height).toBeLessThan(48)
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await window.screenshot({ path: `tests/e2e/results/team-summary-${width}.png` })

    await summary.getByRole('button', { name: 'View team', exact: true }).click()
    await expect(window.getByRole('region', { name: 'Task room' })).toBeVisible()
  })
}

const MEMBER_REPORTS = [
  { summary: 'Tier comparison is done', content: 'Tier comparison is done.\n\nBasic is 12 per seat, Pro is 20 per seat; Pro adds audit logs and single sign-on.' },
  { summary: 'Two competitors priced below us', content: 'Two competitors priced below us.\n\nBoth undercut Basic by about 15%; neither offers audit logs.' },
]
const PROGRESS_SUMMARY = 'Pricer finished its assignment'
const SOURCE_TITLE = 'Pricing research'
const SOURCE_NOTE = { summary: 'Competitor list is ready', content: 'Competitor list is ready.\n\nUse the 2026 sheet in the shared folder.' }

for (const width of [1280, 390]) {
  test(`team members' messages read as quiet lines, like a message from another conversation (${width}px)`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'teams.collaboration.member-messages', evidence: 'app-e2e', mode: 'none', variant: { viewport: String(width) } }) } }, async ({ window, collaboration }, info) => {
    await waitForHomePage(window)
    // Stored the way the runtime writes them, after the conversation's last reply, then read on a fresh load.
    const stored = await window.evaluate(async ({ conversationId, teamId, teamName, memberName, reports, progress, sourceTitle, note }) => {
      const api = (window as any).halo
      const add = async (message: Record<string, unknown>) => {
        const added = await api.addMessage('halo-temp', conversationId, message)
        if (!added.success) throw new Error(`Could not store a message precondition: ${added.error}`)
        return added.data as { id: string; timestamp: string }
      }
      const source = (await api.createConversation('halo-temp', sourceTitle)).data as { id: string }
      await api.updateConversation('halo-temp', source.id, { title: sourceTitle })
      const relayed = await add({ role: 'system', source: 'cross-conversation', content: note.content,
        metadata: { fromConversationId: source.id, fromConversationTitle: sourceTitle, summary: note.summary, inputMode: 'turn' } })
      const team = []
      for (const report of reports) {
        team.push(await add({ role: 'system', source: 'team-message', content: report.content,
          metadata: { teamId, teamName, fromMemberName: memberName, summary: report.summary, inputMode: 'turn' } }))
      }
      team.push(await add({ role: 'system', source: 'team-message', content: `[System] Collaboration turn-end report.\n\n- ${memberName} — finished with no error reported.`,
        metadata: { teamId, teamName, fromMemberName: null, summary: progress, inputMode: 'turn', teamTriggerKind: 'member_stopped' } }))
      return { relayed, team }
    }, { conversationId: collaboration.conversationId, teamId: collaboration.teamId, teamName: COLLAB_TEAM_NAME, memberName: COLLAB_MEMBER_NAME,
      reports: MEMBER_REPORTS, progress: PROGRESS_SUMMARY, sourceTitle: SOURCE_TITLE, note: SOURCE_NOTE })
    await window.reload()
    await waitForHomePage(window)
    await window.getByText(COLLAB_CONVERSATION_TITLE, { exact: true }).first().click()
    await window.setViewportSize({ width, height: 844 })

    const rows = stored.team.map(message => window.locator(`[data-message-id="${message.id}"]`))
    const relayedRow = window.locator(`[data-message-id="${stored.relayed.id}"]`)
    const lineOf = (row: typeof relayedRow) => row.getByRole('button').first()
    const wide = width >= 640
    const settle = async (moveAway = true) => {
      if (moveAway) await window.mouse.move(0, 0)
      await window.evaluate(async () => {
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished.catch(() => undefined)))
      })
    }
    // Fresh arrivals open themselves for a moment; the resting state is what is read later.
    for (const row of [relayedRow, ...rows]) await expect(lineOf(row)).toHaveAttribute('aria-expanded', 'false', { timeout: 15000 })

    const texts = [...MEMBER_REPORTS.map(report => [COLLAB_MEMBER_NAME, report.summary]), ['Team progress', PROGRESS_SUMMARY]]
    for (const [index, row] of rows.entries()) {
      await expect(lineOf(row)).toContainText(texts[index][0])
      await expect(lineOf(row)).toContainText(texts[index][1])
      const time = row.locator('time')
      expect(await time.getAttribute('datetime')).toBe(new Date(stored.team[index].timestamp).toISOString())
      await expect(time).toHaveText(/\d{1,2}:\d{2}/)
      // A phone-width line keeps its room for who and what.
      if (wide) await expect(time).toBeVisible()
      else await expect(time).toBeHidden()
      await expect(row.locator('.border')).toHaveCount(0)
      await expect(row).not.toContainText(/\bago\b|Open team view/)
    }
    await expect(rows[0]).not.toContainText('Pro adds audit logs')
    if (wide) await expect(relayedRow.locator('time')).toBeVisible()
    else await expect(relayedRow.locator('time')).toBeHidden()

    // Same shape as the relayed line; one run of lines with nothing between them.
    const relayedBox = (await lineOf(relayedRow).boundingBox())!
    const boxes = await Promise.all(rows.map(async row => (await lineOf(row).boundingBox())!))
    for (const box of boxes) {
      expect(Math.abs(box.height - relayedBox.height)).toBeLessThanOrEqual(1)
      expect(Math.abs(box.x - relayedBox.x)).toBeLessThanOrEqual(1)
    }
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index].y - (boxes[index - 1].y + boxes[index - 1].height)).toBeLessThanOrEqual(1)
    }
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)

    for (const theme of ['dark', 'light'] as const) {
      await setTheme(window, theme)
      await rows.at(-1)!.scrollIntoViewIfNeeded()
      await settle()
      await window.screenshot({ path: info.outputPath(`member-messages-${width}-${theme}-collapsed.png`) })
    }

    // Hovering offers View; nothing on the line moves.
    const cue = lineOf(rows[0]).getByText('View', { exact: true })
    const summary = lineOf(rows[0]).getByText(MEMBER_REPORTS[0].summary, { exact: true })
    const anchor = wide ? rows[0].locator('time') : summary
    const before = (await anchor.boundingBox())!
    await lineOf(rows[0]).hover()
    await expect.poll(() => cue.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    const after = (await anchor.boundingBox())!
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(0.5)
    await settle(false)
    await window.screenshot({ path: info.outputPath(`member-messages-${width}-light-hover.png`) })

    await lineOf(rows[0]).click()
    await lineOf(relayedRow).click()
    await expect(lineOf(rows[0])).toHaveAttribute('aria-expanded', 'true')
    await expect(rows[0].getByText(MEMBER_REPORTS[0].content.split('\n\n')[1], { exact: false })).toBeVisible()
    await expect(rows[0].getByText('From team', { exact: true })).toBeVisible()
    await expect(rows[0].getByText('sent by a team member, not by you', { exact: true })).toBeVisible()
    const teamLink = rows[0].getByRole('button', { name: COLLAB_TEAM_NAME, exact: true })
    await expect(teamLink).toHaveAttribute('title', 'Open team view')
    await expect(relayedRow.getByText("sent by that conversation's AI", { exact: true })).toBeVisible()
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(window, theme)
      await rows.at(-1)!.scrollIntoViewIfNeeded()
      await settle()
      await window.screenshot({ path: info.outputPath(`member-messages-${width}-${theme}-expanded.png`) })
    }

    await teamLink.click()
    await expect(window.getByRole('region', { name: 'Task room' })).toBeVisible()
  })
}
