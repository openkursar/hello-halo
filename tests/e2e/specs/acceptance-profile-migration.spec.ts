import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import type { ActivityEntry } from '../../../src/shared/apps/app-types'
import { test, expect } from '../fixtures/acceptance-app'
import type { ModelRequest } from '../fixtures/acceptance-model'
import { readManagedConversation, readManagedPerson } from '../fixtures/acceptance-management'
import {
  currentRuntimeVersion, legacySchemaIdentity, migrationBackups, migrationFault, prepareLegacyRuntime, profileDatabase,
  readMigrationData, restoreMigrationBackup, type MigrationData,
} from '../fixtures/acceptance-migration-data'
import {
  assertMigratedData, inspectMigratedRecords, migrationAcceptance, migrationLog,
  prepareMigrationIdentity, waitForMigratedRuntime,
} from '../fixtures/acceptance-profile-migration'

test.setTimeout(180000)

test('the current runtime upgrades a real v3 activity database and saves a new report without losing valid older records', migrationAcceptance('lifecycle.install.migrate', 'scripted', { dataset: 'app-runtime-v3' }), async ({ acceptanceApp, model, window }, info) => {
  const identity = await prepareMigrationIdentity(window)
  const priorBackups = new Set(migrationBackups(acceptanceApp.profile).map(backup => backup.file))
  const conversationPath = join(identity.space.path, '.halo', 'conversations', `${identity.conversation.id}.json`)
  const oldConversation = readFileSync(conversationPath, 'utf8')
  let oldData: MigrationData | undefined
  const child = acceptanceApp.app.process()
  let page = await acceptanceApp.restart(profile => { oldData = prepareLegacyRuntime(profile, child, identity.records, false) })
  const observations: Record<string, unknown> = { schema: legacySchemaIdentity(), records: identity.records, oldData }
  const requests: ModelRequest[] = []
  const issues: Array<{ sequence: number; matches: number }> = []
  const reportText = `New report after migration ${identity.records.entryId}`
  const answer = 'The new activity was saved after the real migration.'
  model.respond(request => {
    requests.push(request)
    if (request.toolResults.some(result => result.id === 'migrated-report')) return { text: answer }
    const tools = request.tools.filter(name => name === 'report_to_user' || name.endsWith('__report_to_user'))
    if (tools.length !== 1) {
      issues.push({ sequence: request.sequence, matches: tools.length })
      return { text: 'The required report tool was not available.' }
    }
    return { tools: [{ id: 'migrated-report', name: tools[0], input: { type: 'run_complete', message: reportText } }] }
  })
  try {
    await waitForMigratedRuntime(page, acceptanceApp.profile, identity)
    const migrated = readMigrationData(profileDatabase(acceptanceApp.profile), identity.records)
    assertMigratedData(oldData!, migrated, identity.records)
    observations.migrated = migrated
    observations.readable = await inspectMigratedRecords(page, identity)
    expect(readFileSync(conversationPath, 'utf8')).toBe(oldConversation)
    const backups = migrationBackups(acceptanceApp.profile).filter(backup => !priorBackups.has(backup.file))
    expect(backups).toHaveLength(1)
    expect(readMigrationData(backups[0].file, identity.records)).toEqual(oldData)
    observations.backups = backups

    const triggered = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appTrigger(appId), identity.people[0].id)
    observations.triggered = triggered
    expect(triggered.success).toBe(true)
    expect(triggered.data).toMatchObject({ appId: identity.people[0].id, outcome: 'useful' })
    const runs = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId }), identity.people[0].id)
    expect(runs.success).toBe(true)
    const newRuns = runs.data!.filter(run => run.runId !== identity.records.runId)
    expect(newRuns).toHaveLength(1)
    const [newRun] = newRuns
    expect(newRun).toMatchObject({ appId: identity.people[0].id, triggerType: 'manual', status: 'ok' })
    expect(triggered.data).toMatchObject({ runId: newRun.runId, sessionKey: newRun.sessionKey })
    observations.newRun = newRun
    expect(issues).toEqual([])
    expect(requests).toHaveLength(2)
    const receipt = requests[1].toolResults.filter(result => result.id === 'migrated-report')
    expect(receipt).toHaveLength(1)
    expect(receipt[0].text).toContain('Report saved')
    expect(requests[0].text).toContain(`Manually triggered run for "${identity.people[0].spec.name}"`)
    const transcript = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appGetSession(input), { appId: identity.people[0].id, runId: newRun.runId })
    expect(transcript.success).toBe(true)
    const messages = transcript.data as Array<{ id: string; role: string; content: string }>
    expect(messages.some(message => message.role === 'assistant' && message.content === answer)).toBe(true)
    const activity = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetActivity({ appId }), identity.people[0].id)
    expect(activity.success).toBe(true)
    const newEntries = (activity.data as ActivityEntry[]).filter(entry => entry.content.summary === reportText)
    expect(newEntries).toHaveLength(1)
    const [newEntry] = newEntries
    expect(newEntry).toMatchObject({ appId: identity.people[0].id, runId: newRun.runId, sessionKey: newRun.sessionKey, type: 'run_complete', content: { status: 'ok' } })
    expect(newEntry.id).not.toBe(identity.records.entryId)
    observations.newActivity = newEntry
    observations.transcript = transcript.data
    assertMigratedData(oldData!, readMigrationData(profileDatabase(acceptanceApp.profile), identity.records), identity.records)

    const beforeRestart = migrationBackups(acceptanceApp.profile)
    page = await acceptanceApp.restart()
    await waitForMigratedRuntime(page, acceptanceApp.profile, identity)
    assertMigratedData(oldData!, readMigrationData(profileDatabase(acceptanceApp.profile), identity.records), identity.records)
    await inspectMigratedRecords(page, identity)
    const reopened = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appGetSession(input), { appId: identity.people[0].id, runId: newRun.runId })
    expect(reopened.success).toBe(true)
    expect(reopened.data).toEqual(transcript.data)
    const reopenedRuns = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId }), identity.people[0].id)
    expect(reopenedRuns.success).toBe(true)
    expect(reopenedRuns.data!.filter(run => run.runId === newRun.runId)).toEqual([newRun])
    const reopenedActivity = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetActivity({ appId }), identity.people[0].id)
    expect(reopenedActivity.success).toBe(true)
    expect((reopenedActivity.data as ActivityEntry[]).filter(entry => entry.id === newEntry.id)).toEqual([newEntry])
    expect((reopenedActivity.data as ActivityEntry[]).filter(entry => entry.content.summary === reportText)).toEqual([newEntry])
    observations.reopenedActivity = reopenedActivity.data
    expect(migrationBackups(acceptanceApp.profile)).toEqual(beforeRestart)
    expect(readFileSync(conversationPath, 'utf8')).toBe(oldConversation)
    expect(model.exchanges).toHaveLength(2)
    observations.idempotentVersion = currentRuntimeVersion
  } finally {
    await info.attach('runtime-v3-migration-evidence', { body: JSON.stringify({ ...observations, requests, issues }, null, 2), contentType: 'application/json' })
  }
})

test('a real runtime migration write refusal rolls back and leaves a recoverable product snapshot', migrationAcceptance('lifecycle.install.migration-failure', 'none', { fault: 'runtime-version-write' }), async ({ acceptanceApp, model, window }, info) => {
  model.respond(() => ({ text: 'Unexpected model request during migration failure verification.' }))
  const identity = await prepareMigrationIdentity(window)
  const priorBackups = new Set(migrationBackups(acceptanceApp.profile).map(backup => backup.file))
  const conversationPath = join(identity.space.path, '.halo', 'conversations', `${identity.conversation.id}.json`)
  const oldConversation = readFileSync(conversationPath, 'utf8')
  let oldData: MigrationData | undefined
  const child = acceptanceApp.app.process()
  let page = await acceptanceApp.restart(profile => { oldData = prepareLegacyRuntime(profile, child, identity.records, true) })
  const observations: Record<string, unknown> = { schema: legacySchemaIdentity(), records: identity.records, oldData }
  try {
    await expect.poll(() => migrationLog(acceptanceApp.profile), { timeout: 30000 }).toContain(`Migration failed for namespace "app_runtime" at version 3: ${migrationFault}`)
    await expect.poll(() => migrationLog(acceptanceApp.profile), { timeout: 30000 }).toContain('Platform+Apps initialization failed')
    const retained = readMigrationData(profileDatabase(acceptanceApp.profile), identity.records)
    expect(retained).toEqual(oldData)
    observations.retained = retained
    const activity = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetActivity({ appId }), identity.people[0].id)
    const state = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetState(appId), identity.people[0].id)
    const run = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appTrigger(appId), identity.people[0].id)
    for (const response of [activity, state, run]) {
      expect(response.success, 'A failed migration must not return an empty successful runtime').toBe(false)
      expect(response.error).toMatch(/not(?: yet)? initialized|unavailable|failed/i)
      expect(response.data).toBeUndefined()
    }
    observations.failureResponses = { activity, state, run }
    for (const person of identity.people) expect(await readManagedPerson(page, person.id)).toMatchObject({ id: person.id, spec: person.spec })
    expect((await readManagedConversation(page, identity.space.id, identity.conversation.id)).messages).toEqual(identity.conversation.messages)
    expect(readFileSync(conversationPath, 'utf8')).toBe(oldConversation)
    const backups = migrationBackups(acceptanceApp.profile).filter(backup => !priorBackups.has(backup.file))
    expect(backups).toHaveLength(1)
    expect(readMigrationData(backups[0].file, identity.records)).toEqual(oldData)
    observations.backups = backups
    expect(model.exchanges).toHaveLength(0)

    const failedChild = acceptanceApp.app.process()
    page = await acceptanceApp.restart(profile => restoreMigrationBackup(profile, failedChild, backups[0].file, identity.records))
    await waitForMigratedRuntime(page, acceptanceApp.profile, identity)
    const recovered = readMigrationData(profileDatabase(acceptanceApp.profile), identity.records)
    assertMigratedData(oldData!, recovered, identity.records)
    observations.recovered = recovered
    await inspectMigratedRecords(page, identity)
    expect(migrationBackups(acceptanceApp.profile).find(backup => backup.file === backups[0].file)?.sha256).toBe(backups[0].sha256)
    expect(existsSync(conversationPath)).toBe(true)
    expect(readFileSync(conversationPath, 'utf8')).toBe(oldConversation)
    const snapshots = migrationBackups(acceptanceApp.profile)
    page = await acceptanceApp.restart()
    await waitForMigratedRuntime(page, acceptanceApp.profile, identity)
    expect(readMigrationData(profileDatabase(acceptanceApp.profile), identity.records)).toEqual(recovered)
    expect(migrationBackups(acceptanceApp.profile)).toEqual(snapshots)
    expect(model.exchanges).toHaveLength(0)
  } finally {
    await info.attach('runtime-migration-failure-evidence', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
  }
})
