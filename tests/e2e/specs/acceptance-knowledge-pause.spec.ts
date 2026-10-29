import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { KnowledgeBaseEntry } from '../../../src/shared/types/tlon'
import {
  test, expect, knowledgeAcceptance, createKnowledgeBase, sourceFile, dropKnowledgeFiles,
  assertImportedCopy, waitForKnowledgeFiles, readKnowledgeBases, readKnowledgeIndex, extractedDocument,
} from '../fixtures/acceptance-knowledge'
import { readAcceptanceConversation, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { contentText } from '../fixtures/acceptance-model'
import { openManagedPerson, openManagedPersonSettings, seedManagedPerson } from '../fixtures/acceptance-management'
import { navigateToChat, waitForHomePage } from '../fixtures/helpers'

test.setTimeout(180000)

async function showKnowledge(page: Page, kb: KnowledgeBaseEntry) {
  await waitForHomePage(page)
  await page.getByRole('button', { name: 'Knowledge Base', exact: true }).first().click()
  const back = page.getByRole('button', { name: 'Knowledge Bases', exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByText(kb.name, { exact: true }).click()
  await expect(page.getByRole('heading', { name: kb.name, exact: true })).toBeVisible()
}

async function setLearning(page: Page, kb: KnowledgeBaseEntry, enabled: boolean) {
  await showKnowledge(page, kb)
  const files = page.getByRole('button', { name: 'Files', exact: true })
  await expect(files).toHaveCount(1)
  await files.locator('..').getByRole('button', { name: 'Settings', exact: true }).click()
  const toggle = page.getByText('Keep learning', { exact: true }).locator('../..').getByRole('switch')
  await expect(toggle).toHaveAttribute('aria-checked', String(!enabled))
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(enabled))
  await expect.poll(async () => (await readKnowledgeBases(page)).find(item => item.id === kb.id)?.status).toBe(enabled ? 'active' : 'paused')
}

async function bindWorkspace(page: Page, kb: KnowledgeBaseEntry) {
  await navigateToChat(page)
  await expect(page.getByTitle('Current workspace: Halo Workspace — click to switch', { exact: true })).toBeVisible()
  await page.getByTitle('Load knowledge bases into this conversation', { exact: true }).click()
  const row = page.locator('[role="button"]').filter({ has: page.getByText(kb.name, { exact: true }) })
  await expect(row).toHaveCount(1)
  const bound = (await readKnowledgeBases(page)).find(item => item.id === kb.id)!.spaceIds.includes('halo-temp')
  if (!bound) await row.getByTitle('Always enable in this workspace (applies to new conversations)', { exact: true }).click()
  await expect.poll(async () => (await readKnowledgeBases(page)).find(item => item.id === kb.id)!.spaceIds).toContain('halo-temp')
  await page.keyboard.press('Escape')
}

async function bindPerson(page: Page, kb: KnowledgeBaseEntry, person: InstalledApp) {
  await openManagedPersonSettings(page, person.spec.name)
  const navigation = page.locator('nav').filter({ has: page.getByRole('button', { name: 'Tools & Resources', exact: true }) })
  await navigation.getByRole('button', { name: 'Tools & Resources', exact: true }).click()
  const row = page.locator('#settings-group-tools').getByRole('button').filter({ has: page.getByText(kb.name, { exact: true }) })
  await expect(row).toHaveCount(1)
  const bound = (await readKnowledgeBases(page)).find(item => item.id === kb.id)!.appIds.includes(person.id)
  if (bound) {
    await row.click()
    await expect.poll(async () => (await readKnowledgeBases(page)).find(item => item.id === kb.id)!.appIds.includes(person.id)).toBe(false)
  }
  await row.click()
  await expect.poll(async () => (await readKnowledgeBases(page)).find(item => item.id === kb.id)!.appIds).toContain(person.id)
}

async function freshConversation(page: Page, person?: InstalledApp) {
  if (person) {
    await openManagedPerson(page, person.spec.name)
    await page.getByTitle('Opens the conversation with this digital human in the workspace chat', { exact: true }).click()
    await expect(page.getByTitle(`Chatting with ${person.spec.name}`, { exact: true })).toBeVisible()
  } else {
    await navigateToChat(page)
    const create = page.getByRole('button', { name: 'New', exact: true })
    await expect(create).toHaveCount(1)
    await create.click()
  }
  await expect(page.locator('textarea')).toBeVisible()
  await expect(page.locator('.message-assistant')).toHaveCount(0)
}

for (const entry of ['conversation', 'person'] as const) {
  test(`${entry} fresh work automatically includes knowledge only while its learning switch is enabled`, knowledgeAcceptance('knowledge.use.pause', 'scripted', { entry }), async ({ acceptanceApp, model, window }, info) => {
    expect(await acceptanceApp.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const marker = `Knowledge synopsis ${randomUUID()}`
    const file = sourceFile(acceptanceApp.profile, 'pause-context.md', `# Pause context source\n\n${marker}\n`)
    const kb = await createKnowledgeBase(window, `Pause context ${randomUUID()}`)
    await dropKnowledgeFiles(window, [file])
    await assertImportedCopy(window, kb, file)
    await waitForKnowledgeFiles(window, kb.id, { 'pause-context.md': 'learned' })
    const indexedPath = extractedDocument(await readKnowledgeIndex(window, kb.id), 'pause-context.md')
    const person = entry === 'person' ? await seedManagedPerson(window, 'Knowledge context observer') : undefined
    if (person) await bindPerson(window, kb, person)
    else await bindWorkspace(window, kb)

    const observations: Array<{ stage: string; containsKnowledge: boolean; containsSourcePath: boolean; prompt: string }> = []
    model.respond(request => {
      const stage = request.lastUserText.match(/Complete the context observation: (active|paused|resumed)\./)?.[1]
      if (!stage) throw new Error(`Unexpected knowledge-context request ${request.sequence}`)
      const prompt = [contentText(request.body.system), ...request.messages.filter(message => message.role === 'system').map(message => contentText(message.content))].join('\n')
      observations.push({ stage, containsKnowledge: prompt.includes(`## ${kb.name}`), containsSourcePath: prompt.includes(indexedPath), prompt })
      return { text: `Context observation ${stage} completed.` }
    })
    const conversations: string[] = []
    try {
      for (const [stage, enabled] of [['active', true], ['paused', false], ['resumed', true]] as const) {
        if (stage !== 'active') await setLearning(window, kb, enabled)
        await freshConversation(window, person)
        const question = `Complete the context observation: ${stage}.`
        const reply = `Context observation ${stage} completed.`
        const turn = await sendAcceptanceMessage(window, question)
        conversations.push(turn.conversationId)
        await expect(window.locator('.message-assistant [data-message-content]').filter({ hasText: reply })).toHaveText(reply, { timeout: 30000 })
        if (person) {
          expect(turn.conversationId).toMatch(new RegExp(`^app-chat:${person.id}:local:`))
          await expect.poll(() => window.evaluate(async ({ appId, conversationId }) => {
            const result = await (globalThis as unknown as { halo: HaloAPI }).halo.appChatSessionState(appId, conversationId)
            if (!result.success) throw new Error(`Could not read the real person session: ${result.error}`)
            return (result.data as { isActive: boolean }).isActive
          }, { appId: person.id, conversationId: turn.conversationId })).toBe(false)
          const saved = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appChatTranscript(input), { appId: person.id, spaceId: turn.spaceId, conversationId: turn.conversationId })
          expect(saved.success).toBe(true)
          expect(saved.data?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
          expect(saved.data?.messages.some(message => message.role === 'assistant' && message.content === reply)).toBe(true)
        } else {
          await waitForAcceptanceIdle(window, turn.conversationId)
          const saved = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
          expect(saved.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([question])
          const selection = await window.evaluate(async ({ spaceId, conversationId }) => {
            const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, conversationId)
            return (result.data as { knowledgeBaseIds: string[] }).knowledgeBaseIds
          }, turn)
          expect(selection).toContain(kb.id)
        }
        const binding = (await readKnowledgeBases(window)).find(item => item.id === kb.id)!
        expect(person ? binding.appIds : binding.spaceIds).toContain(person ? person.id : turn.spaceId)
        expect(observations.filter(observation => observation.stage === stage)).toEqual([{ stage, containsKnowledge: enabled, containsSourcePath: enabled, prompt: expect.any(String) }])
      }
      expect(new Set(conversations).size).toBe(3)
      expect(model.exchanges).toHaveLength(3)
    } finally {
      await info.attach('knowledge-pause-context', { body: JSON.stringify({ entry, knowledgeBase: kb.id, indexedPath, conversations, observations }, null, 2), contentType: 'application/json' })
    }
  })
}
