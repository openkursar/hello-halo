import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { Team, TeamDetail, TeamConversation } from '../../../src/shared/apps/team-types'
import type { KnowledgeBaseEntry, RawFileStatus } from '../../../src/shared/types/tlon'
import { test, expect, registryCard, registryPerson, type RegistryResource } from './acceptance-registry'
import { readManagedConversation, readManagedPerson, seedManagedConversation, seedManagedPerson } from './acceptance-management'
import { createKnowledgeBase, readKnowledgeBases, readKnowledgeFiles } from './acceptance-knowledge'
import type ExpectationData from './data/localization-expectations.json'

const expectations = JSON.parse(readFileSync(new URL('./data/localization-expectations.json', import.meta.url), 'utf8')) as typeof ExpectationData

export { test, expect }
export type Locale = 'en' | 'zh-CN'
export type LocalizedSurface = 'chat' | 'people' | 'team-task' | 'settings' | 'store' | 'knowledge'
export const words = (locale: Locale) => expectations[locale]
export const contentName = '中文🧭 English — 保留原始名称与较长说明，不随界面语言改变'
export const contentBody = 'User-authored English remains unchanged.\n中文内容🧭也保持原样，包含完整的长句和数字 87261345。'
export const registryName = `本地目录 ${contentName}`
export const catalogPerson: RegistryResource = registryPerson('locale-owned-definition', `目录人物 ${contentName}`, {
  description: contentBody,
  config: [{ key: 'destination', label: '用户自定义字段🧭 Destination', type: 'text', required: true }],
})

export function localizationAcceptance(surface: LocalizedSurface) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'quality.localization.switch', evidence: 'ui', mode: 'none', variant: { surface } }) } }
}

export interface LocalizationJourney {
  identities: Record<string, unknown>
  exercise(page: Page, locale: Locale, freshApplication?: boolean): Promise<void>
  persisted(page: Page): Promise<void>
  finish?(page: Page, locale: Locale): Promise<void>
}

export async function globalNavigation(page: Page, locale: Locale, destination: 'conversation' | 'people' | 'settings' | 'knowledge' | 'store') {
  const copy = words(locale)
  let primary = page.getByRole('navigation')
  for (const key of ['conversation', 'people', 'knowledge', 'store'] as const) primary = primary.filter({
    has: page.getByRole('button', { name: copy[key], exact: true }),
  })
  await expect(primary).toHaveCount(1)
  // The rail's footer actions sit beside its primary navigation, inside the same parent.
  const button = primary.locator('..').getByRole('button', { name: copy[destination], exact: true })
  await expect(button).toHaveCount(1)
  await expect(button).toBeVisible()
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'page')
}

export async function chooseLocale(page: Page, current: Locale, next: Locale) {
  await globalNavigation(page, current, 'settings')
  const appearance = page.locator('#appearance')
  await appearance.scrollIntoViewIfNeeded()
  await appearance.locator('select').selectOption(next)
  await expect(appearance.getByRole('heading', { name: words(next).appearance, exact: true })).toBeVisible()
  await expect(appearance.getByText(words(next).language, { exact: true })).toBeVisible()
  await expect(appearance.locator('select')).toHaveValue(next)
  expect(await page.evaluate(() => localStorage.getItem('halo-locale'))).toBe(next)
}

export async function expectLocaleRestored(page: Page, locale: Locale) {
  expect(await page.evaluate(() => localStorage.getItem('halo-locale'))).toBe(locale)
  await globalNavigation(page, locale, 'settings')
  const appearance = page.locator('#appearance')
  await appearance.scrollIntoViewIfNeeded()
  await expect(appearance.getByRole('heading', { name: words(locale).appearance, exact: true })).toBeVisible()
  await expect(appearance.locator('select')).toHaveValue(locale)
}

async function errorText(container: Locator, expected: string) {
  const error = container.getByText(expected, { exact: true })
  await expect(error).toBeVisible()
  await expect(error).toHaveText(expected)
  expect(await error.innerText()).not.toMatch(/\{\{[^}]+\}\}/)
}

async function dropComposerFile(page: Page, file: string) {
  const composer = page.locator('textarea').first()
  const box = await composer.boundingBox()
  expect(box).not.toBeNull()
  const session = await page.context().newCDPSession(page)
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await session.send('Input.dispatchDragEvent', {
      type, x: box!.x + box!.width / 2, y: box!.y + box!.height / 2,
      data: { items: [], files: [file], dragOperationsMask: 1 },
    })
  } finally { await session.detach() }
}

export async function chatJourney(page: Page, profile: string): Promise<LocalizationJourney> {
  const conversation = await seedManagedConversation(page, 'halo-temp', `会话 ${contentName}`, [
    { role: 'user', content: contentBody }, { role: 'assistant', content: `保存的回复 ${contentBody}` },
  ])
  const space = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getSpace('halo-temp'))
  expect(space.success).toBe(true)
  const historyFile = join((space.data as { path: string }).path, 'conversations', `${conversation.id}.json`)
  const ownedHistory = relative(realpathSync(profile), realpathSync(historyFile))
  expect(ownedHistory && !isAbsolute(ownedHistory) && ownedHistory !== '..' && !ownedHistory.startsWith(`..${sep}`)).toBeTruthy()
  const historyBytes = readFileSync(historyFile)
  const badImage = join(profile, '失败图片_中文🧭_unchanged.png')
  const bytes = Buffer.from('This is intentionally not a PNG image.')
  writeFileSync(badImage, bytes)
  await page.reload()
  let hasDraft = false
  return {
    identities: { conversationId: conversation.id, title: conversation.title, badImage: basename(badImage) },
    async exercise(window, locale, freshApplication = false) {
      await globalNavigation(window, locale, 'conversation')
      const copy = words(locale)
      const pin = window.locator('button').and(window.getByTitle(copy.pin, { exact: true }).or(window.getByTitle(copy.unpin, { exact: true })))
      const row = window.getByText(conversation.title, { exact: true }).locator('..').filter({ has: pin })
      await expect(row).toHaveCount(1)
      await row.click()
      await expect(window.getByRole('banner').getByText(conversation.title, { exact: true })).toBeVisible()
      for (const message of conversation.messages) await expect(window.locator(`[data-message-id="${message.id}"]`).first()).toContainText(message.content)
      const composer = window.locator('textarea').first()
      const draft = `未发送草稿 ${contentBody}`
      if (hasDraft && !freshApplication) await expect(composer).toHaveValue(draft)
      await composer.fill(draft)
      await dropComposerFile(window, badImage)
      await errorText(window.locator('#root'), words(locale).imageError.replace('{name}', basename(badImage)))
      await expect(composer).toHaveValue(draft)
      hasDraft = true
    },
    async persisted(window) {
      const saved = await readManagedConversation(window, 'halo-temp', conversation.id)
      expect(saved.id).toBe(conversation.id)
      expect(saved.title).toBe(conversation.title)
      expect(saved.messages).toEqual(conversation.messages)
      expect(readFileSync(historyFile)).toEqual(historyBytes)
      expect(readFileSync(badImage)).toEqual(bytes)
    },
    async finish(window) { await window.locator('textarea').first().fill('') },
  }
}

export async function peopleJourney(page: Page): Promise<LocalizationJourney> {
  const person = await seedManagedPerson(page, `人物 ${contentName}`)
  const prompt = `系统说明 ${contentBody}`
  const description = contentBody.replaceAll('\n', ' ')
  const patched = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appUpdateSpec(input), {
    appId: person.id, specPatch: { description, system_prompt: prompt },
  })
  expect(patched.success).toBe(true)
  const original = await readManagedPerson(page, person.id)
  expect(original.spec).toMatchObject({ type: 'automation', description, system_prompt: prompt })
  return {
    identities: { appId: person.id, name: original.spec.name },
    async exercise(window, locale) {
      const copy = words(locale)
      await globalNavigation(window, locale, 'people')
      const search = window.getByRole('textbox', { name: copy.personSearch, exact: true })
      const back = window.getByRole('button', { name: copy.allPeople, exact: true })
      await expect(search.or(back).first()).toBeVisible()
      if (!await search.isVisible()) await back.click()
      await search.fill(original.spec.name)
      await window.getByRole('button', { name: original.spec.name, exact: true }).click()
      await expect(window.getByRole('heading', { name: original.spec.name, exact: true, level: 2 })).toBeVisible()
      await window.getByRole('button', { name: copy.personSettings, exact: true }).click()
      const identity = window.locator('#settings-group-identity')
      await expect(identity.getByRole('heading', { name: copy.identity, exact: true })).toBeVisible()
      await expect(identity.getByText(copy.name, { exact: true })).toBeVisible()
      await expect(identity.getByText(copy.systemPrompt, { exact: true })).toBeVisible()
      const name = identity.locator('input[type="text"]').first()
      await expect(name).toHaveValue(original.spec.name)
      await expect(identity.locator('input[type="text"]').nth(1)).toHaveValue(original.spec.description)
      await expect(identity.locator('textarea')).toHaveValue(prompt)
      await name.fill('')
      await identity.getByRole('button', { name: copy.save, exact: true }).click()
      await errorText(identity, copy.personError)
      expect((await readManagedPerson(window, person.id)).spec).toEqual(original.spec)
      await identity.getByRole('button', { name: copy.reset, exact: true }).click()
      await expect(name).toHaveValue(original.spec.name)
    },
    async persisted(window) {
      expect(await readManagedPerson(window, person.id)).toMatchObject({ id: original.id, specId: original.specId, spaceId: original.spaceId,
        spec: original.spec, permissions: original.permissions, userConfig: original.userConfig, userOverrides: original.userOverrides })
    },
  }
}

export async function settingsJourney(page: Page): Promise<LocalizationJourney> {
  const before = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getConfig())
  expect(before.success).toBe(true)
  const originalProxy = (before.data as { network?: { proxy?: string } }).network?.proxy ?? ''
  const sources = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.storeGetRegistries())
  expect(sources.success).toBe(true)
  return {
    identities: { registryName, proxyInitiallyEmpty: originalProxy === '' },
    async exercise(window, locale) {
      await globalNavigation(window, locale, 'settings')
      const registries = window.locator('#app-store')
      await registries.scrollIntoViewIfNeeded()
      await expect(registries.getByText(registryName, { exact: true })).toBeVisible()
      const system = window.locator('#system')
      await system.scrollIntoViewIfNeeded()
      const proxy = system.getByPlaceholder('http://127.0.0.1:1087', { exact: true })
      await proxy.fill('ftp://127.0.0.1:21')
      await proxy.press('Enter')
      await errorText(system, words(locale).proxyError)
      const current = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getConfig())
      expect(((current.data as { network?: { proxy?: string } }).network?.proxy ?? '')).toBe(originalProxy)
      await proxy.fill(originalProxy)
      await proxy.press('Enter')
    },
    async persisted(window) {
      const current = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.storeGetRegistries())
      expect(current).toEqual(sources)
    },
  }
}

export async function storeJourney(page: Page): Promise<LocalizationJourney> {
  const initial = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList())
  expect(initial.success).toBe(true)
  const initialIds = (initial.data as InstalledApp[]).filter(app => app.spec.store?.slug === catalogPerson.entry.slug).map(app => app.id).sort()
  expect(initialIds).toEqual([])
  return {
    identities: { slug: catalogPerson.entry.slug, name: catalogPerson.entry.name, description: contentBody },
    async exercise(window, locale) {
      const copy = words(locale)
      await globalNavigation(window, locale, 'store')
      const back = window.getByRole('button', { name: copy.storeBack, exact: true })
      const search = window.getByPlaceholder(copy.storeSearch, { exact: true })
      await expect(back.or(search).first()).toBeVisible()
      if (await back.isVisible()) await back.click()
      await expect(search).toBeVisible()
      const storeHeader = search.locator('xpath=ancestor::div[contains(@class,"flex-col")][1]')
      await storeHeader.getByRole('button', { name: copy.digitalHuman, exact: true }).click()
      await registryCard(window, catalogPerson.entry.name).click()
      await expect(back).toBeVisible()
      await expect(window.getByRole('heading', { name: catalogPerson.entry.name, exact: true })).toBeVisible()
      await expect(window.getByText(contentBody, { exact: true }).first()).toBeVisible()
      await window.getByRole('button', { name: copy.install, exact: true }).click()
      const dialog = window.locator('.fixed.inset-0').filter({ has: window.getByRole('heading', { name: catalogPerson.entry.name, exact: true, level: 2 }) })
      await expect(dialog).toHaveCount(1)
      const next = dialog.getByRole('button', { name: copy.next, exact: true })
      if (await next.isVisible()) {
        await expect(dialog.getByText(new RegExp(`\\(${copy.defaultWorkspace}\\)`)).first()).toBeVisible()
        await next.click()
      }
      await expect(dialog.locator('label').filter({ hasText: '用户自定义字段🧭 Destination' })).toHaveText(/^用户自定义字段🧭 Destination\s*\*$/)
      await dialog.getByRole('button', { name: copy.install, exact: true }).click()
      await errorText(dialog, copy.storeError)
      await dialog.getByRole('button', { name: copy.close, exact: true }).click()
      await expect(dialog).toHaveCount(0)
    },
    async persisted(window) {
      const current = await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.appList())
      expect(current.success).toBe(true)
      expect((current.data as InstalledApp[]).filter(app => app.spec.store?.slug === catalogPerson.entry.slug).map(app => app.id).sort()).toEqual(initialIds)
    },
  }
}

export async function teamJourney(page: Page): Promise<LocalizationJourney> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.teamList().then(result => result.success)), {
    timeout: 30000, message: 'The real team service must be ready before creating the stored workbench data',
  }).toBe(true)
  const lead = await seedManagedPerson(page, `Lead ${contentName}`)
  const reviewer = await seedManagedPerson(page, `Reviewer ${contentName}`)
  const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamCreate({ input }), {
    name: `团队 ${contentName}`, owningSpaceId: 'halo-temp', goal: contentBody, memberSourcing: 'manual' as const,
    collabMode: 'structured' as const, escalationRouting: 'user' as const, leadAppId: lead.id,
    members: [{ appId: lead.id, memberName: 'Lead', role: 'Coordinator' }, { appId: reviewer.id, memberName: 'Reviewer', role: 'Reviewer' }],
  })
  expect(result.success).toBe(true)
  const team = result.data as Team
  const work: Array<{ id: string; title: string }> = []
  for (const prefix of ['第一项', '第二项']) {
    const title = `${prefix}任务 ${contentName}`
    const task = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamOpenConversation(input), { teamId: team.id, title, memberAppId: lead.id })
    expect(task.success).toBe(true)
    work.push({ id: (task.data as { epochId: string }).epochId, title })
  }
  const original = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), team.id)
  expect(original.success).toBe(true)
  const remote = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getRemoteStatus())
  expect(remote).toMatchObject({ success: true, data: { enabled: false, server: { running: false } } })
  return {
    identities: { teamId: team.id, members: [lead.id, reviewer.id], tasks: work },
    async exercise(window, locale) {
      const copy = words(locale)
      await globalNavigation(window, locale, 'people')
      const heading = window.getByRole('heading', { name: team.name, exact: true, level: 1 })
      const teams = window.getByRole('button', { name: copy.teams, exact: true })
      await expect(heading.or(teams).first()).toBeVisible()
      if (!await heading.isVisible()) {
        await teams.click()
        const card = window.getByRole('button').filter({ has: window.getByRole('heading', { name: team.name, exact: true, level: 2 }) })
        await expect(heading.or(card).first()).toBeVisible()
        if (!await heading.isVisible()) await card.click()
      }
      await expect(heading).toBeVisible()
      const header = heading.locator('xpath=ancestor::header')
      await header.getByTitle(copy.viewGoal, { exact: true }).click()
      await expect(window.getByRole('heading', { name: copy.teamGoal, exact: true })).toBeVisible()
      await expect(window.getByText(contentBody, { exact: true })).toBeVisible()
      await header.getByTitle(copy.viewGoal, { exact: true }).click()
      await expect(window.getByRole('heading', { name: copy.teamGoal, exact: true })).toHaveCount(0)
      for (const task of work) {
        const navigation = window.getByRole('navigation', { name: copy.tasks, exact: true })
        if (!await navigation.isVisible()) await header.getByRole('button', { name: copy.tasks, exact: true }).click()
        await navigation.getByTitle(task.title, { exact: true }).click()
        const room = window.getByRole('region', { name: copy.taskRoom, exact: true })
        await expect(room.getByRole('heading', { name: task.title, exact: true, level: 2 })).toBeVisible()
        const member = room.getByRole('combobox', { name: copy.chooseMember, exact: true })
        await member.selectOption(reviewer.id)
        await expect(member).toHaveValue(reviewer.id)
      }
      await header.getByRole('button', { name: copy.teamSettings, exact: true }).click()
      await window.getByRole('button', { name: copy.invite, exact: true }).click()
      const dialog = window.locator('.fixed.inset-0').filter({ has: window.getByRole('heading', { name: copy.inviteTitle, exact: true }) })
      await expect(dialog).toHaveCount(1)
      await errorText(dialog, copy.inviteError)
      await expect(dialog.getByRole('button', { name: copy.tryAgain, exact: true })).toBeEnabled()
      await dialog.getByRole('heading', { name: copy.inviteTitle, exact: true }).locator('..').getByRole('button').click()
      await expect(dialog).toHaveCount(0)
    },
    async persisted(window) {
      const current = await window.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.teamGetDetail(id), team.id)
      expect(current.success).toBe(true)
      expect((current.data as TeamDetail).team).toEqual((original.data as TeamDetail).team)
      expect((current.data as TeamDetail).members).toEqual((original.data as TeamDetail).members)
      const tasks = await window.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.teamListConversations(id), team.id)
      expect(tasks.success).toBe(true)
      expect((tasks.data as TeamConversation[]).map(task => ({ id: task.epochId, title: task.label })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...work].sort((a, b) => a.id.localeCompare(b.id)))
      expect(await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getRemoteStatus())).toMatchObject({ success: true, data: { enabled: false, server: { running: false } } })
    },
  }
}

export async function knowledgeJourney(page: Page, application: { profile: string; restart(): Promise<Page> }): Promise<{ page: Page; journey: LocalizationJourney }> {
  const kb = await createKnowledgeBase(page, `知识 ${contentName}`)
  const source = join(application.profile, '知识资料_中文🧭.md')
  const bytes = Buffer.from(`# 用户知识标题🧭\n\n${contentBody}\n`)
  writeFileSync(source, bytes)
  const copied = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.tlonAddFiles(input.id, [input.file]), { id: kb.id, file: source })
  expect(copied.success).toBe(true)
  await expect.poll(async () => (await readKnowledgeFiles(page, kb.id)).find(file => file.name === basename(source))?.state, { timeout: 30000 }).toBe('learned')
  const raw = (await readKnowledgeFiles(page, kb.id)).find(file => file.name === basename(source))!
  const within = relative(realpathSync(application.profile), realpathSync(raw.openPath))
  expect(within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`)).toBeTruthy()
  const folder = join(application.profile, '监视资料🧭'), moved = join(application.profile, '暂时移走的监视资料🧭')
  mkdirSync(folder)
  writeFileSync(join(folder, '原始资料.txt'), contentBody)
  const label = `监视目录 ${contentName}`
  expect((await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.tlonAddLinkedDir(input.id, { path: input.path, label: input.label }), { id: kb.id, path: folder, label })).success).toBe(true)
  await expect.poll(async () => (await readKnowledgeBases(page)).find(entry => entry.id === kb.id)?.linkedDirs.find(dir => dir.path === folder)?.watching, {
    timeout: 30000, message: 'The actual native watcher must start before this case may test its unavailable-folder state',
  }).toBe(true)
  const link = (await readKnowledgeBases(page)).find(entry => entry.id === kb.id)!.linkedDirs.find(dir => dir.path === folder)!
  const watcherMarker = `[Tlon] Watching ${kb.id}:linked:${link.id}:`
  const watcherStarts = () => readFileSync(join(application.profile, '.halo', 'logs', 'main.log'), 'utf8').split(watcherMarker).length - 1
  await expect.poll(watcherStarts, { timeout: 30000, message: 'The native subscription must actually succeed; the optimistic watching flag is not sufficient evidence' }).toBeGreaterThan(0)
  renameSync(folder, moved)
  page = await application.restart()
  await expect.poll(async () => (await readKnowledgeBases(page)).find(entry => entry.id === kb.id)?.linkedDirs.find(dir => dir.id === link.id)?.watching, { timeout: 30000 }).toBe(false)
  const journey: LocalizationJourney = {
    identities: { kbId: kb.id, name: kb.name, file: raw.name, linkId: link.id, label, failure: 'Actual previously watched folder renamed within the owned profile' },
    async exercise(window, locale) {
      const copy = words(locale)
      await globalNavigation(window, locale, 'knowledge')
      const heading = window.getByRole('heading', { name: kb.name, exact: true })
      await expect(heading).toBeVisible()
      if (!await window.getByRole('button', { name: copy.files, exact: true }).isVisible()) await heading.click()
      await window.getByRole('button', { name: copy.files, exact: true }).click()
      await expect(window.getByRole('heading', { name: copy.learned, exact: true })).toBeVisible()
      const row = window.locator('div.group').filter({ has: window.getByText(raw.name, { exact: true }) })
      await expect(row).toHaveCount(1)
      await row.click()
      await expect(window.getByRole('heading', { name: '用户知识标题🧭', exact: true })).toBeVisible()
      await expect(window.getByText(contentBody, { exact: true })).toBeVisible()
      const collapse = window.getByTitle(copy.collapseCanvas, { exact: true })
      if (await collapse.isVisible()) await collapse.click()
      await window.getByRole('button', { name: copy.settings, exact: true }).last().click()
      await expect(window.getByRole('heading', { name: copy.watchedFolders, exact: true })).toBeVisible()
      const linked = window.getByText(label, { exact: true }).locator('xpath=ancestor::div[contains(@class,"group")][1]')
      await errorText(linked, copy.unavailable)
      await linked.getByRole('button', { name: copy.retry, exact: true }).click()
      await expect(linked.getByRole('button', { name: copy.retry, exact: true })).toBeEnabled()
      await errorText(linked, copy.unavailable)
    },
    async persisted(window) {
      const current = (await readKnowledgeBases(window)).find(entry => entry.id === kb.id) as KnowledgeBaseEntry
      expect(current).toMatchObject({ id: kb.id, name: kb.name, path: kb.path })
      expect(current.linkedDirs.find(dir => dir.id === link.id)).toMatchObject({ id: link.id, path: folder, label, watching: false })
      const files = await readKnowledgeFiles(window, kb.id)
      expect(files.find(file => file.name === raw.name)).toMatchObject({ source: 'raw', state: 'learned', openPath: raw.openPath } satisfies Partial<RawFileStatus>)
      expect(readFileSync(source)).toEqual(bytes)
      expect(readFileSync(raw.openPath)).toEqual(bytes)
      expect(readFileSync(join(moved, '原始资料.txt'), 'utf8')).toBe(contentBody)
    },
    async finish(window, locale) {
      const startsBeforeRetry = watcherStarts()
      renameSync(moved, folder)
      const linked = window.getByText(label, { exact: true }).locator('xpath=ancestor::div[contains(@class,"group")][1]')
      await linked.getByRole('button', { name: words(locale).retry, exact: true }).click()
      await expect.poll(async () => (await readKnowledgeBases(window)).find(entry => entry.id === kb.id)?.linkedDirs.find(dir => dir.id === link.id)?.watching, { timeout: 30000 }).toBe(true)
      await expect.poll(watcherStarts, { timeout: 30000, message: 'Retry must restore a real native subscription, not only the displayed availability flag' }).toBeGreaterThan(startsBeforeRetry)
      await expect(linked.getByText(words(locale).unavailable, { exact: true })).toHaveCount(0)
    },
  }
  return { page, journey }
}
