import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { ActivityEntry, InstalledApp } from '../../../src/shared/apps/app-types'
import { expect } from './acceptance-app'
import { readManagedConversation, readManagedPerson, seedManagedConversation, seedManagedSpace } from './acceptance-management'
import {
  currentRuntimeVersion, legacyRuntimeVersion, readMigrationData, profileDatabase,
  type MigrationData, type MigrationRecords,
} from './acceptance-migration-data'

export function migrationAcceptance(caseId: string, mode: 'scripted' | 'none', variant: Record<string, string>) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'integration', mode, variant }) } }
}

export async function prepareMigrationIdentity(page: Page) {
  await expect.poll(() => page.evaluate(async () => {
    const apps = await (window as unknown as { halo: HaloAPI }).halo.appList({ type: 'automation' })
    return apps.success
  }), { timeout: 30000 }).toBe(true)
  const space = await seedManagedSpace(page, 'Migration history workspace')
  const people: InstalledApp[] = []
  for (const name of ['Migrated report owner', 'Migration control owner']) {
    const installed = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({
      spaceId: input.spaceId,
      spec: { spec_version: '1.0', type: 'automation', version: '1.0.0', name: input.name, author: 'Acceptance author',
        description: 'Retains isolated upgrade history.', system_prompt: 'Report only the supplied isolated evidence.',
        subscriptions: [], requires: {}, config_schema: [], permissions: [] },
    }), { spaceId: space.id, name })
    expect(installed.success).toBe(true)
    people.push(await readManagedPerson(page, (installed.data as { appId: string }).appId))
  }
  const conversation = await seedManagedConversation(page, space.id, 'Conversation retained through migration', [
    { role: 'user', content: `Old saved question ${randomUUID()}` },
    { role: 'assistant', content: `Old saved answer ${randomUUID()}` },
  ])
  await expect.poll(async () => {
    const result = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId }), people[0].id)
    return result.success
  }, { timeout: 30000 }).toBe(true)
  const records: MigrationRecords = {
    appIds: people.map(person => person.id), runId: `legacy-run-${randomUUID()}`, sessionKey: `legacy-session-${randomUUID()}`,
    entryId: `legacy-entry-${randomUUID()}`, orphanId: `legacy-orphan-${randomUUID()}`, orphanAppId: `removed-app-${randomUUID()}`,
    summary: `Old activity preserved ${randomUUID()}`, timestamp: Date.now() - 60000,
  }
  return { space, people, conversation, records }
}

export type MigrationIdentity = Awaited<ReturnType<typeof prepareMigrationIdentity>>

export function migrationLog(profile: string) {
  const file = join(profile, '.halo', 'logs', 'main.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export async function waitForMigratedRuntime(page: Page, profile: string, identity: MigrationIdentity) {
  await expect.poll(() => readMigrationData(profileDatabase(profile), identity.records).runtimeVersion, { timeout: 30000 }).toBe(currentRuntimeVersion)
  await expect.poll(async () => {
    const result = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetState(appId), identity.people[0].id)
    return result.success
  }, { timeout: 30000 }).toBe(true)
}

export function assertMigratedData(before: MigrationData, after: MigrationData, records: MigrationRecords) {
  expect(before.runtimeVersion).toBe(legacyRuntimeVersion)
  expect(after.runtimeVersion).toBe(currentRuntimeVersion)
  expect(after.managerVersion).toBe(before.managerVersion)
  expect(after.apps).toEqual(before.apps)
  expect(after.run).toEqual(before.run)
  expect(after.entries).toHaveLength(1)
  const old = before.entries.find(entry => entry.id === records.entryId)!
  const current = after.entries[0]
  const { content_json: oldContent, ...oldFields } = old
  const { content_json: currentContent, ...currentFields } = current
  expect(currentFields).toEqual(oldFields)
  expect(JSON.parse(currentContent as string)).toMatchObject(JSON.parse(oldContent as string))
  expect(JSON.parse(currentContent as string).source).toMatchObject({ kind: 'automation', appId: records.appIds[0], runId: records.runId, sessionKey: records.sessionKey })
  expect(after.activityForeignKeys.some(key => key.from === 'run_id')).toBe(false)
  expect(after.activityForeignKeys.some(key => key.from === 'app_id' && key.table === 'installed_apps')).toBe(true)
  expect(after.foreignKeyViolations).toEqual([])
  expect(after.integrity).toBe('ok')
}

export async function inspectMigratedRecords(page: Page, identity: MigrationIdentity) {
  for (const person of identity.people) {
    const current = await readManagedPerson(page, person.id)
    expect(current).toMatchObject({ id: person.id, spaceId: identity.space.id, specId: person.specId, spec: person.spec })
  }
  const conversation = await readManagedConversation(page, identity.space.id, identity.conversation.id)
  expect(conversation.title).toBe(identity.conversation.title)
  expect(conversation.messages).toEqual(identity.conversation.messages)
  const activity = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetActivity({ appId }), identity.people[0].id)
  expect(activity.success).toBe(true)
  const retained = (activity.data as ActivityEntry[]).find(entry => entry.id === identity.records.entryId)
  expect(retained).toMatchObject({ appId: identity.people[0].id, runId: identity.records.runId, sessionKey: identity.records.sessionKey, type: 'run_complete', content: { summary: identity.records.summary } })
  const runs = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId }), identity.people[0].id)
  expect(runs.success).toBe(true)
  expect(runs.data?.find(run => run.runId === identity.records.runId)).toMatchObject({ appId: identity.people[0].id, sessionKey: identity.records.sessionKey, status: 'ok' })
  return { conversation, retained, runs: runs.data }
}
