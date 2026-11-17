import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../src/shared/types/im-channel'
import { parseAppChatKey, buildImSessionKey } from '../../../src/shared/apps/im-keys'
import { test as base, expect, sendAcceptanceMessage } from './acceptance-app'
import { openManagedPerson, readManagedPerson, workspaceCard, type ManagedSpace } from './acceptance-management'
import { waitForHomePage } from './helpers'
import { startAcceptanceWecom, type AcceptanceWecom } from './acceptance-wecom'
import { startAcceptanceMcp } from './acceptance-mcp'

export { acceptance } from './acceptance-app'
export { expect } from '@playwright/test'
export const MOVE_OWNER = 'acceptance-move-owner'

export const test = base.extend<{ wecom: AcceptanceWecom; moveMcp: Awaited<ReturnType<typeof startAcceptanceMcp>> }>({
  moveMcp: async ({}, use) => {
    const service = await startAcceptanceMcp()
    try { await use(service) } finally { await service.close() }
  },
  wecom: async ({}, use, info) => {
    const wecom = await startAcceptanceWecom()
    try { await use(wecom) }
    finally {
      await wecom.close()
      await info.attach('workspace-move-wecom', { body: JSON.stringify({ replies: wecom.replies, errors: wecom.errors }, null, 2), contentType: 'application/json' })
      expect(wecom.errors).toEqual([])
    }
  },
})

export interface MoveChat { spaceId: string; conversationId: string; name: string; first: string; reply: string; nativeId: string }

export const appRoot = (space: Pick<ManagedSpace, 'path'>, appId: string) => join(space.path, '.halo', 'apps', appId)

export async function installMovePerson(page: Page, spaceId: string, name: string): Promise<InstalledApp> {
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.appGetOverview().then(result => result.success)), { timeout: 30000 }).toBe(true)
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({ spaceId: input.spaceId, spec: {
    spec_version: '1.0', version: '1.0.0', type: 'automation', name: input.name, author: 'Acceptance',
    description: 'Synthetic local workspace continuity checks.', system_prompt: 'Help with the isolated task. Report independent work through report_to_user.',
    subscriptions: [{ id: 'continuity-schedule', source: { type: 'schedule', config: { every: '24h' } } }],
    requires: {}, permissions: [], config_schema: [],
  } }), { spaceId, name })
  expect(result.success).toBe(true)
  const data = result.data as { appId: string; activationWarning?: string }
  expect(data.activationWarning).toBeUndefined()
  const settings = await page.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({ appId, overrides: { notificationLevel: 'none', memory: { autoConsolidate: false } } }), data.appId)
  expect(settings.success).toBe(true)
  return readManagedPerson(page, data.appId)
}

export function seedMoveMemory(root: string, fact: string) {
  mkdirSync(join(root, 'memory', 'topics'), { recursive: true })
  writeFileSync(join(root, 'memory.md'), `# now\n\n## State | Continuity\n- ${fact}\n\n# History\n`)
  writeFileSync(join(root, 'memory', 'topics', 'continuity.md'), `---\nname: continuity\ndescription: Synthetic retained context\n---\n\n${fact}\n`)
}

function runKey(appId: string, conversationId: string) {
  assert.ok(parseAppChatKey(conversationId)?.appId === appId)
  return `chat-${conversationId.slice(`app-chat:${appId}:`.length).replace(/:/g, '-')}`
}

export function chatBinding(root: string, appId: string, conversationId: string) {
  const map = JSON.parse(readFileSync(join(root, 'runs', '_session-ids.json'), 'utf8'))
  const binding = map[runKey(appId, conversationId)] as { engineId: string; sessionId: string }
  expect(binding).toMatchObject({ engineId: 'halo', sessionId: expect.any(String) })
  expect(binding.sessionId.length).toBeGreaterThan(0)
  return binding
}

export async function waitForMoveChat(page: Page, appId: string, conversationId: string) {
  await expect.poll(async () => {
    const state = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId), { appId, conversationId })
    expect(state.success).toBe(true)
    return (state.data as { isActive: boolean }).isActive
  }, { timeout: 30000 }).toBe(false)
}

export async function openMoveConversationPage(page: Page) {
  await waitForHomePage(page)
  const narrow = page.getByRole('button', { name: 'Navigate', exact: true })
  if (await narrow.isVisible()) {
    await narrow.click()
    await expect(page.getByRole('heading', { name: 'Navigate', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Conversation', exact: true }).filter({ visible: true }).click()
    await expect(page.getByRole('heading', { name: 'Navigate', exact: true })).toHaveCount(0)
  } else {
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  }
  await expect(page.getByTitle(/^Current workspace: .* — click to switch$/)).toBeVisible()
}

export async function openMoveWorkspaces(page: Page) {
  if (await page.getByRole('heading', { name: 'Workspace', exact: true, level: 1 }).isVisible()) return
  await openMoveConversationPage(page)
  const breadcrumb = page.getByTitle('Manage workspaces', { exact: true })
  if (await breadcrumb.isVisible()) await breadcrumb.click()
  else {
    await page.getByTitle(/^Current workspace: .* — click to switch$/).click()
    await page.getByRole('button', { name: 'Manage workspaces', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true, level: 1 })).toBeVisible()
}

export async function openMoveChat(page: Page, person: InstalledApp) {
  const current = await readManagedPerson(page, person.id)
  expect(current.spaceId).toBeTruthy()
  await openMoveWorkspaces(page)
  const space = await page.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSpace(id), current.spaceId!)
  expect(space.success).toBe(true)
  const home = space.data as ManagedSpace
  if (home.id !== 'halo-temp') await workspaceCard(page, home.name).click()
  const sessions = async () => {
    const result = await page.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.imSessionsList(appId), person.id)
    expect(result.success).toBe(true)
    return ((result.data ?? []) as ImSessionRecord[]).filter(record => record.channel === 'local')
  }
  const previous = new Set((await sessions()).map(record => record.chatId))
  await openManagedPerson(page, person.spec.name)
  await page.getByTitle('Opens the conversation with this digital human in the workspace chat', { exact: true }).click()
  await expect(page.getByPlaceholder(`Chat with ${person.spec.name}...`, { exact: true })).toBeVisible()
  await expect(page.getByTitle(/^Current workspace: .* — click to switch$/)).toHaveAttribute('title', `Current workspace: ${home.id === 'halo-temp' ? 'Halo Workspace' : home.name} — click to switch`)
  await expect.poll(async () => (await sessions()).filter(record => !previous.has(record.chatId)).length).toBe(1)
  const created = (await sessions()).find(record => !previous.has(record.chatId))!
  const conversationId = buildImSessionKey(person.id, 'local', 'direct', created.chatId)
  expect(parseAppChatKey(conversationId)).toMatchObject({ appId: person.id, channel: 'local' })
  return { spaceId: home.id, conversationId }
}

export async function createMoveChat(page: Page, person: InstalledApp, root: string, first: string): Promise<MoveChat> {
  const expectedTarget = await openMoveChat(page, person)
  const target = await sendAcceptanceMessage(page, first, { expectedTarget })
  const reply = `Retained native reply: ${first}`
  await expect(page.locator('.message-assistant [data-message-content]').last()).toHaveText(reply)
  await waitForMoveChat(page, person.id, target.conversationId)
  const parsed = parseAppChatKey(target.conversationId)!
  const name = `Continuity ${randomUUID().slice(0, 8)}`
  const named = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.imSessionsSetCustomName(input), { appId: person.id, channel: parsed.channel, chatId: parsed.chatId, name })
  expect(named.success).toBe(true)
  return { ...target, name, first, reply, nativeId: chatBinding(root, person.id, target.conversationId).sessionId }
}

export async function connectMoveIm(page: Page, appId: string, wecom: AcceptanceWecom) {
  const instance: ImChannelInstanceConfig = {
    id: `acceptance-move-${randomUUID()}`, appId, type: 'wecom-bot', enabled: true,
    config: { botId: wecom.botId, secret: wecom.secret, wsUrl: wecom.url, nameResolveUrl: '', quoteReply: true },
    replyScope: 'all', permissionEnabled: true, owners: [MOVE_OWNER], streaming: false, processingNotice: false,
  }
  const before = wecom.authenticationCount
  const created = await page.evaluate(instance => (globalThis as unknown as { halo: HaloAPI }).halo.imChannelsCreateInstance(instance), instance)
  expect(created.success).toBe(true)
  await expect.poll(() => wecom.authenticationCount, { timeout: 30000 }).toBeGreaterThan(before)
  await wecom.awaitAuthenticated()
  return instance.id
}

export async function sendMoveIm(page: Page, appId: string, wecom: AcceptanceWecom, question: string) {
  const sent = await wecom.sendText({ senderId: MOVE_OWNER, chatId: MOVE_OWNER, chatType: 'direct', text: question })
  await wecom.waitForReply({ requestId: sent.requestId, contains: `Retained native reply: ${question}` })
  const conversationId = buildImSessionKey(appId, 'wecom-bot', 'direct', MOVE_OWNER)
  await waitForMoveChat(page, appId, conversationId)
  return conversationId
}

export async function movePreview(page: Page, person: InstalledApp, target: ManagedSpace) {
  await openManagedPerson(page, person.spec.name)
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('button', { name: 'Change workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Change workspace', exact: true })
  await dialog.getByRole('combobox').selectOption(target.id)
  await dialog.getByRole('button', { name: 'Preview change', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Move here', exact: true })).toBeEnabled()
  await expect(dialog).toContainText('Memory and all conversations move to the new workspace together.')
  await expect(dialog).toContainText('Files in the project folder stay where they are.')
  return dialog
}

export async function readMoveTranscript(page: Page, appId: string, spaceId: string, conversationId: string) {
  const result = await page.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId, spaceId, conversationId, limit: 100 })
  expect(result.success).toBe(true)
  return result.data!.messages
}

export function readMovePersistence(profile: string, appId: string) {
  const db = new Database(join(profile, '.halo', 'halo.db'), { readonly: true, fileMustExist: true })
  try {
    const person = db.prepare('SELECT space_id, data_path, status FROM installed_apps WHERE id = ?').get(appId)
    const sessions = db.prepare('SELECT session_key, environment_json FROM app_session_environments WHERE app_id = ?').all(appId) as Array<{ session_key: string; environment_json: string }>
    const runs = db.prepare('SELECT run_id, environment_json FROM automation_runs WHERE app_id = ?').all(appId) as Array<{ run_id: string; environment_json: string | null }>
    return { person, sessions: sessions.map(row => ({ key: row.session_key, environment: JSON.parse(row.environment_json) })), runs: runs.map(row => ({ key: row.run_id, environment: row.environment_json ? JSON.parse(row.environment_json) : null })) }
  } finally { db.close() }
}

export function assertMoveEnvironments(profile: string, appId: string, target: ManagedSpace) {
  const state = readMovePersistence(profile, appId)
  expect(state.person).toMatchObject({ space_id: target.id, data_path: null })
  expect(state.sessions.length).toBeGreaterThan(0)
  for (const row of [...state.sessions, ...state.runs]) {
    expect(row.environment, `Retained environment ${row.key}`).toMatchObject({ spaceId: target.id, spacePath: target.path, workDir: target.id === 'halo-temp' ? join(target.path, 'artifacts') : target.workingDir ?? target.path, memoryDir: appRoot(target, appId) })
  }
  return state
}

export function treeContents(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  const files: Record<string, string> = {}
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [path, value] of Object.entries(treeContents(join(root, entry.name)))) files[join(entry.name, path)] = value
    else if (entry.isFile()) files[entry.name] = readFileSync(join(root, entry.name)).toString('base64')
    else throw new Error('The controlled continuity fixture must not contain links or special files')
  }
  return files
}

function assertOwned(profile: string, path: string) {
  const child = relative(profile, path)
  assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`), 'Legacy preparation may touch only the isolated profile')
}

/** Reconstructs app-owned legacy records only after the isolated process exits; native engine storage is never edited. */
export function prepareLegacyMove(input: { profile: string; child: Pick<ChildProcess, 'exitCode' | 'signalCode'>; person: InstalledApp; origin: ManagedSpace; target: ManagedSpace; snapshot: string; sourceChat: MoveChat; destinationChat: MoveChat; variant: 'available' | 'deleted' | 'missing-pin' | 'retained-pin' }) {
  const { profile, child, person, origin, target, snapshot, sourceChat, destinationChat, variant } = input
  assert.ok(child.exitCode != null || child.signalCode != null, 'Legacy preparation requires a confirmed process exit')
  const source = appRoot(origin, person.id)
  const destination = appRoot(target, person.id)
  for (const path of [source, destination, snapshot, origin.path]) assertOwned(profile, path)
  assert.ok(existsSync(snapshot) && existsSync(destination))
  const db = new Database(join(profile, '.halo', 'halo.db'), { fileMustExist: true })
  try {
    const before = readMovePersistence(profile, person.id)
    const originEnvironment = { spaceId: origin.id, spacePath: origin.path, workDir: origin.workingDir ?? origin.path, memoryDir: source }
    db.transaction(() => {
      db.prepare('UPDATE installed_apps SET data_path = ? WHERE id = ? AND space_id = ?').run(variant === 'missing-pin' || variant === 'retained-pin' ? null : source, person.id, target.id)
      for (const row of before.sessions) {
        if (row.key === destinationChat.conversationId || row.key === `legacy-file:${person.id}:${runKey(person.id, destinationChat.conversationId)}`) continue
        const environment = { ...row.environment, ...originEnvironment }
        db.prepare('UPDATE app_session_environments SET environment_json = ? WHERE session_key = ?').run(JSON.stringify(environment), row.key)
      }
      for (const row of before.runs) db.prepare('UPDATE automation_runs SET environment_json = ? WHERE run_id = ?').run(JSON.stringify({ ...row.environment, ...originEnvironment }), row.key)
    })()
    if (variant === 'available' || variant === 'retained-pin') {
      cpSync(snapshot, source, { recursive: true, errorOnExist: true })
      const mapFile = join(destination, 'runs', '_session-ids.json')
      const map = JSON.parse(readFileSync(mapFile, 'utf8'))
      const sourceMap = JSON.parse(readFileSync(join(source, 'runs', '_session-ids.json'), 'utf8'))
      for (const key of Object.keys(sourceMap)) {
        delete map[key]
        const transcript = join(destination, 'runs', `${key}.jsonl`)
        if (existsSync(transcript)) rmSync(transcript)
      }
      writeFileSync(mapFile, JSON.stringify(map, null, 2))
      writeFileSync(join(source, 'source-only.txt'), 'source-only continuity\n')
      writeFileSync(join(destination, 'destination-only.txt'), 'destination-only continuity\n')
      writeFileSync(join(source, 'memory.md'), '# now\n\nSource conflict memory remains available.\n')
      writeFileSync(join(destination, 'memory.md'), '# now\n\nDestination conflict memory stays authoritative.\n')
      expect(sourceMap[runKey(person.id, sourceChat.conversationId)].sessionId).toBe(sourceChat.nativeId)
      expect(map[runKey(person.id, destinationChat.conversationId)].sessionId).toBe(destinationChat.nativeId)
    } else {
      // Retained destination transcripts are genuine prior copies; unavailable source memory cannot be recovered.
      if (existsSync(join(destination, 'memory.md'))) rmSync(join(destination, 'memory.md'))
      if (existsSync(join(destination, 'memory'))) rmSync(join(destination, 'memory'), { recursive: true })
      rmSync(origin.path, { recursive: true })
    }
    return { variant, before, prepared: readMovePersistence(profile, person.id), sourceFiles: treeContents(source), destinationFiles: treeContents(destination) }
  } finally { db.close() }
}
