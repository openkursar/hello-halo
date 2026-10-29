import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { MemorySettings } from '../../../src/shared/types/memory'
import type { Thought } from '../../../src/shared/types/transcript'
import { expect, readAcceptanceConversation, readAcceptanceErrors, waitForAcceptanceIdle } from './acceptance-app'
import {
  listManagedConversations, openManagedPerson, openManagedPersonSettings, openWorkspaceMenu, readManagedPerson,
  seedManagedSpace, workspaceCard, type ManagedSpace,
} from './acceptance-management'
import { navigateToChat, navigateToWorkspaces } from './helpers'

export interface SyntheticMemory {
  file: string
  topicFile: string
  fact: string
  topic: string
  topicBody: string
}

export interface MemoryWorld {
  space: ManagedSpace
  people: [InstalledApp, InstalledApp]
  workspace: SyntheticMemory
  personal: [SyntheticMemory, SyntheticMemory]
}

function memorySwitch(container: Locator, label: 'Memory' | 'Automatic consolidation' | 'Use workspace memory') {
  const text = label === 'Memory' ? 'When off, the AI neither reads nor writes this memory. Existing memory is kept.' : label
  return container.getByText(text, { exact: true }).locator('../..').getByRole('switch')
}

async function setSwitch(container: Locator, label: Parameters<typeof memorySwitch>[1], value: boolean) {
  const toggle = memorySwitch(container, label)
  await expect(toggle).toHaveCount(1)
  await expect(toggle).toBeEnabled()
  if (await toggle.getAttribute('aria-checked') !== String(value)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(value))
}

async function expandAdvanced(container: Locator) {
  const disclosure = container.getByRole('button', { name: 'Advanced', exact: true })
  await expect(disclosure).toHaveCount(1)
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
}

export async function setWorkspaceMemory(page: Page, space: ManagedSpace, settings: MemorySettings) {
  await navigateToChat(page)
  await navigateToWorkspaces(page)
  await openWorkspaceMenu(page, space.name, 'Edit')
  const dialog = page.locator('.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Edit Workspace', exact: true }) })
  await expect(dialog).toHaveCount(1)
  await expandAdvanced(dialog)
  if (settings.autoConsolidate !== undefined) await setSwitch(dialog, 'Automatic consolidation', settings.autoConsolidate)
  if (settings.enabled !== undefined) await setSwitch(dialog, 'Memory', settings.enabled)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => {
    const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.getSpacePreferences(id), space.id)
    expect(result.success).toBe(true)
    const memory = (result.data as { memory?: MemorySettings }).memory ?? {}
    return { ...memory, enabled: memory.enabled !== false }
  }).toMatchObject({ ...settings })
}

export async function setPersonMemory(page: Page, person: InstalledApp, settings: MemorySettings & { inherit?: boolean }) {
  await openManagedPersonSettings(page, person.spec.name)
  const advanced = page.locator('#settings-group-advanced')
  await expandAdvanced(advanced)
  if (settings.autoConsolidate !== undefined) {
    await setSwitch(advanced, 'Automatic consolidation', settings.autoConsolidate)
    await expect.poll(async () => (await readManagedPerson(page, person.id)).userOverrides.memory?.autoConsolidate).toBe(settings.autoConsolidate)
  }
  if (settings.enabled !== undefined) {
    await setSwitch(advanced, 'Memory', settings.enabled)
    await expect.poll(async () => (await readManagedPerson(page, person.id)).userOverrides.memory?.enabled !== false).toBe(settings.enabled)
  }
  if (settings.inherit !== undefined) {
    await setSwitch(advanced, 'Use workspace memory', settings.inherit)
    await expect.poll(async () => (await readManagedPerson(page, person.id)).userOverrides.spaceMemoryAccess === true).toBe(settings.inherit)
  }
}

function seedMemory(profile: string, base: string, label: string): SyntheticMemory {
  const owned = relative(realpathSync(profile), realpathSync(base))
  expect(owned.length > 0 && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`)).toBe(true)
  const file = join(base, 'memory.md')
  const topicFile = join(base, 'memory', 'topics', 'reference.md')
  const fact = `${label}Fact-${randomUUID()}`
  const topic = `${label}Topic-${randomUUID()}`
  const topicBody = `${label}TopicBody-${randomUUID()}`
  mkdirSync(join(base, 'memory', 'topics'), { recursive: true })
  writeFileSync(file, `# now\n\n## State | Synthetic continuity\n- Reference: ${fact}\n\n# History\n`)
  writeFileSync(topicFile, `---\nname: ${label} reference\ndescription: Recall ${topic} when reviewing this isolated topic.\n---\n\n# Reference detail\n\n${topicBody}\n`)
  return { file, topicFile, fact, topic, topicBody }
}

export async function createMemoryWorld(page: Page, profile: string): Promise<MemoryWorld> {
  await navigateToChat(page)
  const space = await seedManagedSpace(page, 'Isolated memory workspace')
  const people: InstalledApp[] = []
  for (const name of ['First memory owner', 'Second memory owner']) {
    const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({
      spaceId: input.spaceId,
      spec: {
        spec_version: '1.0', version: '1.0.0', type: 'automation', name: input.name,
        author: 'Acceptance author', description: 'Reviews isolated continuity evidence.',
        system_prompt: 'Review only the supplied isolated evidence.', subscriptions: [], requires: {}, config_schema: [], permissions: [],
      },
    }), { name, spaceId: space.id })
    expect(result.success).toBe(true)
    const person = await readManagedPerson(page, (result.data as { appId: string }).appId)
    expect(person).toMatchObject({ spaceId: space.id, status: 'active' })
    people.push(person)
  }
  await setWorkspaceMemory(page, space, { autoConsolidate: false })
  for (const person of people) await setPersonMemory(page, person, { autoConsolidate: false, inherit: false })
  const personal: SyntheticMemory[] = []
  for (const [index, person] of people.entries()) {
    const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appGetDataPath(id), person.id)
    expect(result.success).toBe(true)
    expect(result.data?.path).toBeTruthy()
    personal.push(seedMemory(profile, result.data!.path, `Person${index + 1}`))
  }
  return {
    space, people: people as MemoryWorld['people'],
    workspace: seedMemory(profile, join(space.path, '.halo'), 'Workspace'),
    personal: personal as MemoryWorld['personal'],
  }
}

export function snapshotMemory(memory: SyntheticMemory) {
  return [memory.file, memory.topicFile].map(file => {
    const stat = statSync(file, { bigint: true })
    return { file, content: readFileSync(file, 'utf8'), modified: String(stat.mtimeNs), changed: String(stat.ctimeNs), inode: String(stat.ino) }
  })
}

export async function openFreshMemoryConversation(page: Page, world: MemoryWorld, person?: InstalledApp) {
  await navigateToChat(page)
  await navigateToWorkspaces(page)
  const card = workspaceCard(page, world.space.name)
  await expect(card).toHaveCount(1)
  await card.click()
  await expect(page.getByTitle(`Current workspace: ${world.space.name} — click to switch`, { exact: true })).toBeVisible()
  // Initialize the ordinary workspace through its UI before testing memory in a person's new chat.
  await expect.poll(async () => (await listManagedConversations(page, world.space.id)).length).toBeGreaterThan(0)
  if (person) {
    await openManagedPerson(page, person.spec.name)
    await page.getByTitle('Opens the conversation with this digital human in the workspace chat', { exact: true }).click()
    await expect(page.getByTitle(`Chatting with ${person.spec.name}`, { exact: true })).toBeVisible()
  } else {
    await page.getByRole('button', { name: 'New', exact: true }).click()
  }
  await expect(page.getByTitle(`Current workspace: ${world.space.name} — click to switch`, { exact: true })).toBeVisible()
  await expect(page.locator('.message-user')).toHaveCount(0)
  await expect(page.locator('textarea').first()).toHaveValue('')
}

export async function finishMemoryConversation(page: Page, turn: { spaceId: string; conversationId: string }, question: string, answer: string, person?: InstalledApp) {
  await expect(page.locator('.message-assistant [data-message-content]').filter({ hasText: answer })).toHaveText(answer)
  if (!person) {
    await waitForAcceptanceIdle(page, turn.conversationId)
    const stored = await readAcceptanceConversation(page, turn.spaceId, turn.conversationId)
    expect(stored.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
    expect(stored.messages.some(message => message.role === 'assistant' && message.content === answer && !message.error)).toBe(true)
    return stored.messages
  }
  expect(turn.conversationId).toMatch(new RegExp(`^app-chat:${person.id}:local:`))
  await expect.poll(() => page.evaluate(async input => {
    const result = await (window as unknown as { halo: HaloAPI }).halo.appChatSessionState(input.appId, input.conversationId)
    if (!result.success || !result.data) throw new Error('The actual memory session is unavailable')
    return (result.data as { isActive: boolean }).isActive
  }, { appId: person.id, conversationId: turn.conversationId })).toBe(false)
  await expect(page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
  expect(await readAcceptanceErrors(page)).toEqual([])
  const stored = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: person.id, ...turn })
  expect(stored.success).toBe(true)
  expect(stored.data?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
  expect(stored.data?.messages.some(message => message.role === 'assistant' && message.content === answer)).toBe(true)
  return stored.data!.messages
}

export async function readPersonMemoryThoughts(page: Page, person: InstalledApp, turn: { spaceId: string; conversationId: string }, messages: Array<{ id: string; role: string }>): Promise<Thought[]> {
  const thoughts: Thought[] = []
  for (const message of messages.filter(message => message.role === 'assistant')) {
    const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appChatMessageThoughts(input), { appId: person.id, ...turn, messageId: message.id })
    expect(result.success).toBe(true)
    thoughts.push(...(result.data ?? []))
  }
  return thoughts.filter(thought => thought.type === 'tool_use')
}
