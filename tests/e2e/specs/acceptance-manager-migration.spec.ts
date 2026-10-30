import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ActivityEntry, InstalledApp } from '../../../src/shared/apps/app-types'
import { test, expect, sendAcceptanceMessage, waitForAcceptanceIdle, readAcceptanceConversation } from '../fixtures/acceptance-app'
import type { AcceptanceModel, ModelRequest } from '../fixtures/acceptance-model'
import { openManagedConversation, readManagedConversation, seedManagedConversation, seedManagedSpace } from '../fixtures/acceptance-management'
import { migrationBackups } from '../fixtures/acceptance-migration-data'
import { setWorkspaceMemory } from '../fixtures/acceptance-memory'
import { navigateToSettings } from '../fixtures/helpers'
import {
  currentManagerVersion, expectedManagerRows, managerProfileDatabase, managerSchemaIdentity,
  prepareLegacyManager, prepareManagerScopes, readManagerMigration, readMigrationApp,
} from '../fixtures/acceptance-manager-migration'

test.setTimeout(180000)

async function installPerson(page: Page, spaceId: string, name: string, token: string) {
  const response = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: input.spaceId,
    spec: { spec_version: '1.0', type: 'automation', version: '1.0.0', name: input.name,
      author: 'Acceptance author', description: 'A retained manager migration identity.',
      system_prompt: `Report only the supplied isolated work. Actor marker ${input.token}.`,
      config_schema: [{ key: 'label', label: 'Report label', type: 'text' }],
      subscriptions: [], requires: {}, permissions: [] },
    userConfig: { label: `Retained configuration ${input.token}` },
  }), { spaceId, name, token })
  expect(response.success).toBe(true)
  const id = (response.data as { appId: string }).appId
  const configured = await page.evaluate(async appId => {
    const api = (window as unknown as { halo: HaloAPI }).halo
    return [
      await api.appUpdateOverrides({ appId, overrides: { notificationLevel: 'none', memory: { enabled: false, autoConsolidate: false } } }),
      await api.appGrantPermission({ appId, permission: 'browser' }),
      await api.appRevokePermission({ appId, permission: 'shell' }),
    ]
  }, id)
  for (const result of configured) expect(result.success).toBe(true)
  return readMigrationApp(page, id)
}

async function reportRun(page: Page, model: AcceptanceModel, app: InstalledApp, phase: string) {
  const toolId = `manager-report-${phase}`
  const report = `Manager migration ${phase} report ${randomUUID()}`
  const answer = `The ${phase} manager migration report was saved.`
  const requests: ModelRequest[] = [], missingTools: number[] = []
  model.respond(request => {
    requests.push(request)
    if (request.toolResults.some(result => result.id === toolId)) return { text: answer }
    const tools = request.tools.filter(name => name === 'report_to_user' || name.endsWith('__report_to_user'))
    if (tools.length !== 1) { missingTools.push(tools.length); return { text: 'The report tool was unavailable.' } }
    return { tools: [{ id: toolId, name: tools[0], input: { type: 'run_complete', message: report } }] }
  })
  const triggered = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appTrigger(appId), app.id)
  expect(triggered.success).toBe(true)
  expect(triggered.data).toMatchObject({ appId: app.id, outcome: 'useful' })
  const runs = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId }), app.id)
  expect(runs.success).toBe(true)
  const run = runs.data!.find(run => run.runId === (triggered.data as { runId: string }).runId)!
  expect(run).toMatchObject({ appId: app.id, status: 'ok', triggerType: 'manual' })
  const activity = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetActivity({ appId }), app.id)
  expect(activity.success).toBe(true)
  const entries = (activity.data as ActivityEntry[]).filter(entry => entry.content.summary === report)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ appId: app.id, runId: run.runId, sessionKey: run.sessionKey, type: 'run_complete' })
  const transcript = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appGetSession(input), { appId: app.id, runId: run.runId })
  expect(transcript.success).toBe(true)
  expect((transcript.data as Array<{ role: string; content: string }>).some(message => message.role === 'assistant' && message.content === answer)).toBe(true)
  expect(missingTools).toEqual([])
  expect(requests).toHaveLength(2)
  expect(requests[0].text).toContain(`Manually triggered run for "${app.spec.name}"`)
  expect(requests[1].toolResults.filter(result => result.id === toolId)).toHaveLength(1)
  expect(requests[1].toolResults.find(result => result.id === toolId)!.text).toContain('Report saved')
  return { run, activity: entries[0], transcript: transcript.data, requests }
}

async function inspectRun(page: Page, appId: string, saved: Awaited<ReturnType<typeof reportRun>>) {
  const [runs, activity, transcript] = await page.evaluate(async input => {
    const api = (window as unknown as { halo: HaloAPI }).halo
    return Promise.all([api.appGetRuns({ appId: input.appId }), api.appGetActivity({ appId: input.appId }), api.appGetSession(input)])
  }, { appId, runId: saved.run.runId })
  for (const result of [runs, activity, transcript]) expect(result.success).toBe(true)
  expect.soft(runs.data!.filter(run => run.runId === saved.run.runId), 'An existing run must survive the parent table migration').toEqual([saved.run])
  expect.soft((activity.data as ActivityEntry[]).filter(entry => entry.id === saved.activity.id), 'Existing report activity must survive the parent table migration').toEqual([saved.activity])
  expect.soft(transcript.data).toEqual(saved.transcript)
}

test('a real manager v2 profile retains people and skills, keeps existing activity and can save new work after upgrading', {
  annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'lifecycle.install.migrate', variant: { dataset: 'app-manager-v2' }, evidence: 'integration', mode: 'scripted' }) },
}, async ({ acceptanceApp, model, window }, info) => {
  const token = randomUUID().slice(0, 8)
  const observations: Record<string, unknown> = { schema: managerSchemaIdentity() }
  const workspace = await seedManagedSpace(window, `Manager history ${token}`)
  await setWorkspaceMemory(window, workspace, { enabled: false, autoConsolidate: false })
  observations.skillContext = { workspaceMemory: 'disabled through the actual workspace settings UI', instructions: 'loaded by native slash handling from the retained skill file' }
  const controlSpace = await seedManagedSpace(window, `Manager scope control ${token}`)
  observations.scopedBootstrapApps = await prepareManagerScopes(window, acceptanceApp.profile, controlSpace.id)
  const active = await installPerson(window, workspace.id, `Retained active ${token}`, `active-${token}`)
  const paused = await installPerson(window, workspace.id, `Retained paused ${token}`, `paused-${token}`)
  const removed = await installPerson(window, workspace.id, `Retained removed ${token}`, `removed-${token}`)
  expect((await window.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appPause(id), paused.id)).success).toBe(true)
  expect((await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appUpdateOverrides(input), { appId: paused.id, overrides: { frequency: '5m' } })).success).toBe(true)
  expect((await window.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appUninstall({ appId }), removed.id)).success).toBe(true)
  const skillName = `retained-manager-skill-${token}`
  const skillInstruction = `Retained skill instructions ${randomUUID()} and 87261345.`
  const skillText = `---\nname: ${skillName}\ndescription: A retained migration skill.\nuser-invocable: true\n---\n\n${skillInstruction}\n`
  const installedSkill = await window.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: input.spaceId, spec: { spec_version: '1.0', type: 'skill', version: '1.0.0', name: input.name,
      author: 'Acceptance author', description: 'A retained migration skill.', skill_files: { 'SKILL.md': input.content } },
  }), { spaceId: workspace.id, name: skillName, content: skillText })
  expect(installedSkill.success).toBe(true)
  const skill = await readMigrationApp(window, (installedSkill.data as { appId: string }).appId)
  const ids = [active.id, paused.id, removed.id, skill.id]
  const discovered = await window.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.appListAvailableSkillsForSpace(spaceId), workspace.id)
  expect(discovered.success).toBe(true)
  const matches = discovered.data!.filter(item => item.dirName === skillName)
  expect(matches).toHaveLength(1)
  const skillFile = join(realpathSync(matches[0].path), 'SKILL.md')
  const actorPath = await window.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appGetDataPath(id), active.id)
  expect(actorPath.success).toBe(true)
  const actorFile = join(actorPath.data!.path, 'migration-control.txt')
  for (const directory of [matches[0].path, actorPath.data!.path]) {
    const owned = relative(realpathSync(acceptanceApp.profile), realpathSync(directory))
    expect(owned && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`)).toBeTruthy()
  }
  const actorText = `Keep the actor's own file ${randomUUID()}`
  writeFileSync(actorFile, actorText)
  expect(readFileSync(skillFile, 'utf8')).toBe(skillText)
  const conversation = await seedManagedConversation(window, workspace.id, `Manager conversation ${token}`, [
    { role: 'user', content: `Old manager question ${randomUUID()}` }, { role: 'assistant', content: `Old manager answer ${randomUUID()}` },
  ])
  const conversationFile = join(workspace.path, '.halo', 'conversations', `${conversation.id}.json`)
  const conversationBytes = readFileSync(conversationFile)
  const oldWork = await reportRun(window, model, active, 'before')
  observations.oldWork = oldWork
  const priorBackups = migrationBackups(acceptanceApp.profile)
  const child = acceptanceApp.app.process()
  let prepared: ReturnType<typeof prepareLegacyManager> | undefined
  let page = await acceptanceApp.restart(profile => { prepared = prepareLegacyManager(profile, child, ids) })
  observations.prepared = prepared
  try {
    await expect.poll(() => readManagerMigration(managerProfileDatabase(acceptanceApp.profile), ids).version, { timeout: 30000 }).toBe(currentManagerVersion)
    await expect.poll(() => page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appGetState(id).then(result => result.success), active.id), { timeout: 30000 }).toBe(true)
    await expect.poll(async () => (await Promise.all([active.id, paused.id].map(id => readMigrationApp(page, id)))).map(app => app.knowledgeSeeded), {
      timeout: 30000, message: 'Finish the documented live-person knowledge backfill before comparing restart stability',
    }).toEqual([true, true])
    const migrated = readManagerMigration(managerProfileDatabase(acceptanceApp.profile), ids)
    observations.migrated = migrated
    expect.soft(migrated.apps).toEqual(expectedManagerRows(prepared!.old.apps))
    expect.soft(migrated.namespaces).toEqual(prepared!.old.namespaces)
    expect.soft(migrated.runs, 'Manager migration must retain the real runtime run').toEqual(prepared!.old.runs)
    expect.soft(migrated.activity, 'Manager migration must retain the real runtime activity').toEqual(prepared!.old.activity)
    expect(migrated.foreignKeyViolations).toEqual([])
    expect(migrated.integrity).toBe('ok')
    for (const row of migrated.extensions) {
      expect(row).toMatchObject({ upgrade_strategy: 'auto', ignored_versions: '[]', data_path: null, author_spec_json: null })
    }
    for (const id of ids) {
      const before = prepared!.old.apps.find(row => row.id === id)!
      const now = await readMigrationApp(page, id)
      const overrides = JSON.parse(before.user_overrides_json as string)
      delete overrides.frequency
      expect(now).toMatchObject({ id, specId: before.spec_id, spaceId: before.space_id, spec: JSON.parse(before.spec_json as string),
        status: before.status, userConfig: JSON.parse(before.user_config_json as string), userOverrides: overrides,
        permissions: JSON.parse(before.permissions_json as string), installedAt: before.installed_at })
      expect(now.userOverrides).toEqual(overrides)
    }
    const newBackups = migrationBackups(acceptanceApp.profile).filter(backup => !priorBackups.some(old => old.file === backup.file))
    expect(newBackups).toHaveLength(1)
    expect(readManagerMigration(newBackups[0].file, ids)).toEqual(prepared!.old)
    observations.backups = newBackups
    await inspectRun(page, active.id, oldWork)
    const newWork = await reportRun(page, model, active, 'after')
    observations.newWork = newWork
    expect(newWork.run.runId).not.toBe(oldWork.run.runId)
    const skillConversation = await seedManagedConversation(page, workspace.id, `Migrated skill use ${token}`, [])
    const skillRequests: ModelRequest[] = []
    const skillReply = 'The migrated skill instructions are available for this new task.'
    model.respond(request => { skillRequests.push(request); return { text: skillReply } })
    await navigateToSettings(page)
    await openManagedConversation(page, skillConversation.title, workspace.id, { empty: true })
    const skillCommand = `/${skillName} inspect the retained instructions`
    const skillTurn = await sendAcceptanceMessage(page, skillCommand)
    expect(skillTurn.conversationId).toBe(skillConversation.id)
    await waitForAcceptanceIdle(page, skillConversation.id)
    expect(skillRequests).toHaveLength(1)
    const skillBlocks = [...skillRequests[0].lastUserText.matchAll(/<skill-instructions name="([^"]+)">\n([\s\S]*?)\n<\/skill-instructions>/g)]
    expect(skillBlocks).toHaveLength(1)
    expect(skillBlocks[0][1]).toBe(skillName)
    expect(skillBlocks[0][2]).toBe(skillInstruction)
    const skillMessages = await readAcceptanceConversation(page, workspace.id, skillConversation.id)
    expect(skillMessages.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([skillCommand])
    expect(skillMessages.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([skillReply])
    observations.skillUse = { requests: skillRequests, conversation: skillMessages }
    const finalState = readManagerMigration(managerProfileDatabase(acceptanceApp.profile), ids)
    const finalBackups = migrationBackups(acceptanceApp.profile)
    page = await acceptanceApp.restart()
    await expect.poll(() => page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appGetState(id).then(result => result.success), active.id), { timeout: 30000 }).toBe(true)
    expect(readManagerMigration(managerProfileDatabase(acceptanceApp.profile), ids)).toEqual(finalState)
    expect(migrationBackups(acceptanceApp.profile)).toEqual(finalBackups)
    await inspectRun(page, active.id, oldWork)
    await inspectRun(page, active.id, newWork)
    expect(await readAcceptanceConversation(page, workspace.id, skillConversation.id)).toEqual(skillMessages)
    expect((await readManagedConversation(page, workspace.id, conversation.id)).messages).toEqual(conversation.messages)
    expect(readFileSync(conversationFile)).toEqual(conversationBytes)
    expect(readFileSync(actorFile, 'utf8')).toBe(actorText)
    expect(readFileSync(skillFile, 'utf8')).toBe(skillText)
    const skillsAfter = await page.evaluate(spaceId => (window as unknown as { halo: HaloAPI }).halo.appListAvailableSkillsForSpace(spaceId), workspace.id)
    expect(skillsAfter.success).toBe(true)
    expect(skillsAfter.data!.filter(item => item.dirName === skillName)).toEqual(matches)
    expect(model.exchanges).toHaveLength(5)
  } finally {
    await info.attach('manager-v2-migration-evidence', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
  }
})
