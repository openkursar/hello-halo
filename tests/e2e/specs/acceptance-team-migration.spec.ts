import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { EpochBoard, Team, TeamConversation, TeamDetail } from '../../../src/shared/apps/team-types'
import { test, expect } from '../fixtures/acceptance-app'
import type { ModelRequest } from '../fixtures/acceptance-model'
import { readManagedPerson, seedManagedConversation, seedManagedSpace } from '../fixtures/acceptance-management'
import { migrationBackups } from '../fixtures/acceptance-migration-data'
import {
  currentTeamVersion, expectedTeamRows, prepareLegacyTeam, readTeamMigration,
  teamHistory, teamProfileDatabase, teamSchemaIdentity, type TeamMigrationIdentity,
} from '../fixtures/acceptance-team-migration'

test.setTimeout(180000)

async function detail(page: Page, teamId: string) {
  const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), teamId)
  expect(result.success).toBe(true)
  expect(result.data).toBeTruthy()
  return result.data as TeamDetail
}

async function board(page: Page, teamId: string, epochId: string) {
  const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamEpochBoard(input), { teamId, epochId })
  expect(result.success).toBe(true)
  expect(result.data).toBeTruthy()
  return result.data as EpochBoard
}

async function tasks(page: Page, teamId: string) {
  const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.teamListConversations(id), teamId)
  expect(result.success).toBe(true)
  return result.data as TeamConversation[]
}

async function inspectHistory(page: Page, ids: TeamMigrationIdentity, original: TeamDetail) {
  const retained = await detail(page, ids.teamId)
  expect(retained.team).toMatchObject({ ...original.team })
  expect(retained.members).toEqual(original.members)
  expect(retained.edges).toEqual(original.edges)
  const old = await board(page, ids.teamId, ids.epochId)
  expect(old.epoch).toMatchObject({ id: ids.epochId, teamId: ids.teamId, endReason: 'completed', workItem: { status: 'completed' } })
  expect(old.tasks.find(task => task.id === teamHistory.task.id)).toMatchObject({ title: teamHistory.task.title, status: 'done', note: teamHistory.task.note, assigneeAppId: ids.memberId, createdByAppId: ids.leadId })
  expect(old.findings.find(finding => finding.id === teamHistory.finding.id)).toMatchObject({ body: teamHistory.finding.body, authorAppId: ids.memberId })
  expect(old.activities?.find(activity => activity.id === teamHistory.activity.id)).toMatchObject({ kind: 'task_update', status: 'done', actorAppId: ids.memberId, refId: teamHistory.task.id })
  const listed = await tasks(page, ids.teamId)
  expect(listed.find(task => task.epochId === ids.epochId)).toMatchObject({ completed: true, label: 'Retained completed team work' })
  const binding = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.teamCollabForConversation(id), ids.conversationId)
  expect(binding).toMatchObject({ success: true, data: { teamId: teamHistory.duplicates[1].id, epochId: `${teamHistory.duplicates[1].id}-epoch`, active: false } })
  for (const duplicate of teamHistory.duplicates) {
    const current = await detail(page, duplicate.id)
    expect(current.team).toMatchObject({ id: duplicate.id, name: duplicate.name, ephemeral: true,
      coordinatorConversationId: duplicate.id === teamHistory.duplicates[1].id ? ids.conversationId : null })
    expect(current.members.map(member => member.appId).sort()).toEqual([ids.memberId, `space-conv-${ids.conversationId}`].sort())
    const archived = await board(page, duplicate.id, `${duplicate.id}-epoch`)
    expect(archived.epoch).toMatchObject({ endReason: 'completed', workItem: { status: 'completed' } })
    expect(archived.findings).toHaveLength(1)
    expect(archived.findings[0]).toMatchObject({ id: `${duplicate.id}-finding`, body: `Retained independent finding for ${duplicate.name}` })
  }
  const triggers = await page.evaluate(teamId => (window as unknown as { halo: HaloAPI }).halo.teamListTriggers(teamId), ids.teamId)
  expect(triggers).toMatchObject({ success: true, data: [{ id: teamHistory.trigger.id, enabled: false, sourceType: 'schedule', config: { every: '24h' } }] })
  const audit = await page.evaluate(teamId => (window as unknown as { halo: HaloAPI }).halo.teamToolAudit({ teamId }), ids.teamId)
  expect(audit.success).toBe(true)
  expect((audit.data as Array<{ id: string }>).find(entry => entry.id === teamHistory.audit.id)).toMatchObject({ toolName: 'Read', detail: teamHistory.audit.detail, decision: 'allowed' })
  return { retained, board: old, binding: binding.data, triggers: triggers.data, audit: audit.data }
}

test('a real team v19 profile retains members, permissions and completed work while making its collaboration binding unique', {
  annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'lifecycle.install.migrate', variant: { dataset: 'team-v19' }, evidence: 'integration', mode: 'scripted' }) },
}, async ({ acceptanceApp, model, window }, info) => {
  const observations: Record<string, unknown> = { schema: teamSchemaIdentity() }
  const requests: ModelRequest[] = [], issues: string[] = []
  model.respond(request => { issues.push(`Unexpected precondition request ${request.sequence}`); return { text: 'No model work was requested during historical preparation.' } })
  await expect.poll(() => window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.teamList().then(result => result.success)), { timeout: 30000 }).toBe(true)
  const token = randomUUID().slice(0, 8)
  const space = await seedManagedSpace(window, `Team migration ${token}`)
  const actors = []
  for (const role of ['Lead', 'Reviewer', 'Control']) {
    const installed = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({ spaceId: input.spaceId,
      spec: { spec_version: '1.0', type: 'automation', version: '1.0.0', name: input.name, author: 'Acceptance author',
        description: 'An isolated actor retained through team migration.', system_prompt: 'Perform only the explicit isolated team work.',
        subscriptions: [], requires: {}, config_schema: [], permissions: [] },
    }), { spaceId: space.id, name: `${role} migration ${token}` })
    expect(installed.success).toBe(true)
    const app = await readManagedPerson(window, (installed.data as { appId: string }).appId)
    expect((await window.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({ appId, overrides: { notificationLevel: 'none', memory: { enabled: false, autoConsolidate: false } } }), app.id)).success).toBe(true)
    actors.push(await readManagedPerson(window, app.id))
  }
  const [lead, reviewer, control] = actors
  const created = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamCreate({ input }), {
    name: `Retained team ${token}`, goal: 'Preserve old work and carry out one new isolated review.', owningSpaceId: space.id,
    memberSourcing: 'manual' as const, collabMode: 'structured' as const, escalationRouting: 'user' as const, leadAppId: lead.id,
    members: [{ appId: lead.id, memberName: 'Lead', role: 'Coordinator', duty: 'Retain the team outcome.' },
      { appId: reviewer.id, memberName: 'Reviewer', role: 'Reviewer', duty: 'Retain the independent review.' }],
  })
  expect(created.success).toBe(true)
  const team = created.data as Team
  const policy = { allowedTools: ['Read'], allowedSkills: [], allowChecks: false, allowApps: false, allowTerminal: false }
  expect((await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamUpdateMember(input), {
    teamId: team.id, appId: reviewer.id, input: { duty: 'Keep this owner-selected reviewer duty.', delegatedPolicy: policy },
  })).success).toBe(true)
  const oldTask = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamOpenConversation(input), { teamId: team.id, title: 'Retained completed team work', memberAppId: lead.id })
  expect(oldTask.success).toBe(true)
  const epochId = (oldTask.data as { epochId: string }).epochId
  expect((await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamArchiveConversation(input), { teamId: team.id, epochId })).success).toBe(true)
  const original = await detail(window, team.id)
  expect(original.members.find(member => member.appId === reviewer.id)).toMatchObject({ delegatedPolicy: policy, acceptsChecks: false })
  const conversation = await seedManagedConversation(window, space.id, `Old collaboration source ${token}`, [
    { role: 'user', content: `Retained independent source ${randomUUID()}` }, { role: 'assistant', content: 'The old source remains readable.' },
  ])
  const file = join(space.path, '.halo', 'conversations', `${conversation.id}.json`)
  const originalBytes = readFileSync(file)
  const ids: TeamMigrationIdentity = { teamId: team.id, spaceId: space.id, leadId: lead.id, memberId: reviewer.id, epochId, conversationId: conversation.id }
  const previousBackups = migrationBackups(acceptanceApp.profile)
  await expect.poll(() => {
    try { return typeof JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'bundle-seed.json'), 'utf8'))['builtin-skills'] === 'string' }
    catch { return false }
  }, { timeout: 30000, message: 'Finish real startup seeding before freezing unrelated manager rows' }).toBe(true)
  const child = acceptanceApp.app.process()
  let prepared: ReturnType<typeof prepareLegacyTeam> | undefined
  let page = await acceptanceApp.restart(profile => { prepared = prepareLegacyTeam(profile, child, ids) })
  observations.prepared = prepared
  try {
    await expect.poll(() => readTeamMigration(teamProfileDatabase(acceptanceApp.profile)).version, { timeout: 30000 }).toBe(currentTeamVersion)
    await expect.poll(() => page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.teamList().then(result => result.success)), { timeout: 30000 }).toBe(true)
    const migrated = readTeamMigration(teamProfileDatabase(acceptanceApp.profile))
    expect(migrated.tables).toEqual(expectedTeamRows(prepared!.old.tables))
    expect(migrated.namespaces).toEqual(prepared!.old.namespaces)
    expect(migrated.managerRows).toEqual(prepared!.old.managerRows)
    expect(migrated.foreignKeyViolations).toEqual([])
    expect(migrated.integrity).toBe('ok')
    observations.migrated = migrated
    observations.history = await inspectHistory(page, ids, original)
    const backups = migrationBackups(acceptanceApp.profile).filter(item => !previousBackups.some(before => before.file === item.file))
    expect(backups).toHaveLength(1)
    expect(readTeamMigration(backups[0].file)).toEqual(prepared!.old)
    observations.backups = backups
    expect(model.exchanges).toHaveLength(0)

    const newTask = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamOpenConversation(input), { teamId: team.id, title: 'New review after migration', memberAppId: lead.id })
    expect(newTask.success).toBe(true)
    const newEpochId = (newTask.data as { epochId: string }).epochId
    expect(newEpochId).not.toBe(epochId)
    const newTitle = `New board review ${randomUUID()}`
    const finding = `New finding after migration ${randomUUID()}`
    const question = `Create and complete the new reviewer task ${newTitle}, then record ${finding}.`
    const answer = 'The new team task and finding were saved after migration.'
    let newBoardTaskId: string | undefined
    model.respond(request => {
      requests.push(request)
      const call = (name: string, id: string, input: Record<string, unknown>) => {
        const matches = request.tools.filter(tool => tool === name || tool.endsWith(`__${name}`))
        if (matches.length !== 1) { issues.push(`Expected one ${name}, observed ${matches.length}`); return { text: 'The requested team tool was unavailable.' } }
        return { tools: [{ name: matches[0], id, input }] }
      }
      if (request.toolResults.some(result => result.id === 'migrated-finding')) return { text: answer }
      if (request.toolResults.some(result => result.id === 'migrated-task-update')) return call('team_post_finding', 'migrated-finding', { content: finding })
      const posted = request.toolResults.find(result => result.id === 'migrated-task-post')
      if (posted) {
        newBoardTaskId = posted.text.match(/Task created \(id: ([^)]+)\)/)?.[1]
        if (!newBoardTaskId) { issues.push('The real task creation did not return its identity'); return { text: 'The new task identity was unavailable.' } }
        return call('team_update_task', 'migrated-task-update', { taskId: newBoardTaskId, status: 'done', note: 'The lead completed the requested isolated review.' })
      }
      return call('team_post_task', 'migrated-task-post', { title: newTitle, assignee: 'Reviewer' })
    })
    const sent = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamSendToMember(input), { teamId: team.id, appId: lead.id, epochId: newEpochId, spaceId: space.id, message: question })
    observations.sent = sent
    expect(sent).toMatchObject({ success: true, data: { ok: true, finalMessage: answer } })
    await expect.poll(async () => (await tasks(page, team.id)).find(task => task.epochId === newEpochId)?.active, { timeout: 30000 }).toBe(false)
    expect((await tasks(page, team.id)).find(task => task.epochId === newEpochId)).toMatchObject({ label: 'New review after migration', completed: false, memberAppId: lead.id })
    expect(issues).toEqual([])
    expect(requests).toHaveLength(4)
    expect(requests.every(request => request.text.includes(question))).toBe(true)
    const updated = await board(page, team.id, newEpochId)
    expect(updated.tasks).toHaveLength(1)
    expect(updated.tasks[0]).toMatchObject({ id: newBoardTaskId, title: newTitle, status: 'done', assigneeAppId: reviewer.id, createdByAppId: lead.id })
    expect(updated.findings).toHaveLength(1)
    expect(updated.findings[0]).toMatchObject({ body: finding, authorAppId: lead.id })
    for (const kind of ['task_post', 'task_update', 'finding']) expect(updated.activities?.filter(activity => activity.kind === kind && activity.actorAppId === lead.id)).toHaveLength(1)
    const transcript = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamChatMessages(input), { teamId: team.id, epochId: newEpochId, appId: lead.id, spaceId: space.id })
    expect(transcript.success).toBe(true)
    const messages = transcript.data as Array<{ id: string; role: string; content: string }>
    expect(messages.filter(message => message.role === 'user').some(message => message.content.includes(question))).toBe(true)
    expect(messages.filter(message => message.role === 'assistant').some(message => message.content === answer)).toBe(true)
    observations.work = { epochId: newEpochId, board: updated, transcript: transcript.data }
    await inspectHistory(page, ids, original)
    expect(await readManagedPerson(page, control.id)).toEqual(control)
    const beforeRestart = readTeamMigration(teamProfileDatabase(acceptanceApp.profile))
    const allBackups = migrationBackups(acceptanceApp.profile)
    page = await acceptanceApp.restart()
    await expect.poll(() => page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.teamList().then(result => result.success)), { timeout: 30000 }).toBe(true)
    expect(readTeamMigration(teamProfileDatabase(acceptanceApp.profile))).toEqual(beforeRestart)
    expect(migrationBackups(acceptanceApp.profile)).toEqual(allBackups)
    await inspectHistory(page, ids, original)
    expect(await board(page, team.id, newEpochId)).toEqual(updated)
    const reopened = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamChatMessages(input), { teamId: team.id, epochId: newEpochId, appId: lead.id, spaceId: space.id })
    expect(reopened).toMatchObject({ success: true, data: transcript.data })
    expect(await readManagedPerson(page, control.id)).toEqual(control)
    expect(readFileSync(file)).toEqual(originalBytes)
    expect(model.exchanges).toHaveLength(4)
  } finally {
    await info.attach('team-v19-migration-evidence', { body: JSON.stringify({ ...observations, requests, issues }, null, 2), contentType: 'application/json' })
  }
})
