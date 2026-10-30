import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { Thought } from '../../../src/shared/types/transcript'
import { test, expect, readAcceptanceConversation, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { createMigrationCommand, installLegacySpaceIndex, migrationFileIdentity, type HistoricalConversation, type SpaceIndexDataset } from '../fixtures/acceptance-space-index-migration'

test.setTimeout(120000)

type InstalledInput = ReturnType<typeof installLegacySpaceIndex>

function assertOriginalFiles(input: InstalledInput, hasNewWork: boolean) {
  const normalized = new Set(input.spaces.flatMap(space => space.conversations.map(conversation => join(space.path, '.halo', 'conversations', `${conversation.id}.json`))))
  if (hasNewWork) normalized.add(join(input.spaces.find(space => space.meta.id === input.workSpaceId)!.path, '.halo', 'conversations', 'index.json'))
  for (const file of input.files.filter(file => !normalized.has(file.path))) {
    assert.deepEqual(migrationFileIdentity(file.path), file.identity, `Original workspace file changed: ${file.path}`)
  }
}

function oldHistoryIdentity(input: InstalledInput) {
  return input.spaces.flatMap(space => space.conversations.map(conversation => ({
    id: conversation.id, ...migrationFileIdentity(join(space.path, '.halo', 'conversations', `${conversation.id}.json`)),
  })))
}

async function inspectLegacyData(page: Page, input: InstalledInput, added?: { spaceId: string; id: string }) {
  const listed = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.listSpaces())
  expect(listed.success).toBe(true)
  const spaces = listed.data as Array<{ id: string; sortOrder: number }>
  expect(spaces.map(space => space.id)).toEqual(input.expectedOrder)
  const index = JSON.parse(readFileSync(input.index, 'utf8'))
  expect(index.version).toBe(3)
  expect(Object.keys(index.spaces).sort()).toEqual([...input.expectedOrder].sort())
  for (const [position, id] of input.expectedOrder.entries()) {
    const expected = input.spaces.find(space => space.meta.id === id)!
    const { preferences, id: _id, ...metadata } = expected.meta
    expect(index.spaces[id]).toMatchObject({ ...metadata, sortOrder: position })
    expect(realpathSync(index.spaces[id].path)).toBe(realpathSync(expected.path))
    expect(index.spaces[id].workingDir).toBe(expected.meta.workingDir)
    expect(index.spaces[id]).not.toHaveProperty('preferences')
    const actual = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.getSpace(id), id)
    expect(actual).toMatchObject({ success: true, data: { ...expected.meta, isTemp: false, isMissing: false, sortOrder: position } })
    expect(realpathSync((actual.data as { path: string }).path)).toBe(realpathSync(expected.path))
    expect((actual.data as { workingDir?: string }).workingDir).toBe(expected.meta.workingDir)
    if (preferences) expect((actual.data as { preferences: unknown }).preferences).toEqual(preferences)
    const list = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.listConversations(id), id)
    expect(list.success).toBe(true)
    const conversations = list.data as Array<HistoricalConversation>
    const expectedIds = expected.conversations.map(conversation => conversation.id)
    expect(conversations.map(conversation => conversation.id)).toEqual(added?.spaceId === id ? [added.id, ...expectedIds] : expectedIds)
    for (const conversation of expected.conversations) {
      const { messages, version: _version, ...meta } = conversation
      expect(conversations.find(item => item.id === conversation.id)).toMatchObject(meta)
      const read = await page.evaluate(({ spaceId, id }) => (window as unknown as { halo: HaloAPI }).halo.getConversation(spaceId, id), { spaceId: id, id: conversation.id })
      expect(read.success).toBe(true)
      expect(read.data).toMatchObject(meta)
      expect((read.data as HistoricalConversation).messages).toEqual(messages)
      const stored = JSON.parse(readFileSync(join(expected.path, '.halo', 'conversations', `${conversation.id}.json`), 'utf8'))
      expect(stored).toEqual({ ...conversation, version: 2 })
    }
  }
  for (const unregistered of input.spaces.filter(space => !space.registered)) {
    const response = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.getSpace(id), unregistered.meta.id)
    expect(response.success && !!response.data).toBe(false)
  }
  assertOriginalFiles(input, !!added)
  return { index, listed: spaces, oldHistory: oldHistoryIdentity(input) }
}

for (const dataset of ['space-index-v1', 'space-index-v2'] as const satisfies readonly SpaceIndexDataset[]) {
  test(`${dataset} retains workspace identities, ordered history and the actual working directory`, {
    annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'lifecycle.install.migrate', evidence: 'integration', mode: 'scripted', variant: { dataset } }) },
  }, async ({ acceptanceApp, model }, info) => {
    const child = acceptanceApp.app.process()
    let input!: InstalledInput
    let page = await acceptanceApp.restart(profile => { input = installLegacySpaceIndex(profile, child, dataset) })
    const observations: Record<string, unknown> = { dataset, fixture: { producer: input.producer, sha256: input.fixtureHash } }
    const provider: Array<{ questionPresent: boolean; bashTools: string[]; result?: { id: string; text: string; error: boolean } }> = []
    try {
      observations.firstRead = await inspectLegacyData(page, input)
      const firstIndex = migrationFileIdentity(input.index)
      const oldHistory = oldHistoryIdentity(input)
      page = await acceptanceApp.restart()
      observations.reopened = await inspectLegacyData(page, input)
      expect(migrationFileIdentity(input.index)).toEqual(firstIndex)
      expect(oldHistoryIdentity(input)).toEqual(oldHistory)
      expect(model.exchanges).toHaveLength(0)
      const runtime = await acceptanceApp.app.evaluate(() => ({ executable: process.execPath, platform: process.platform, node: process.versions.node }))
      const engine = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
      expect(engine).toMatchObject({ success: true, data: { activeEngine: 'halo', degradedFrom: null } })
      observations.runtime = { ...runtime, engine: engine.data }
      if (runtime.platform === 'win32') {
        const shell = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getGitBashStatus())
        observations.windowsShell = shell
        expect(shell).toMatchObject({ success: true, data: { found: true } })
        const data = shell.data as { source: string; mockMode?: boolean }
        expect(data.source, 'The Windows shell must be real; missing host prerequisites remain a failed validation').not.toBe('mock')
        expect(data.mockMode).not.toBe(true)
      }
      const command = createMigrationCommand(input.root, runtime.executable, runtime.platform)
      const question = `Write the new workspace receipt ${command.marker}.`
      const answer = `New workspace work recorded ${command.marker}.`
      const toolId = 'migrated-workspace-command'
      model.respond(request => {
        const result = request.toolResults.find(result => result.id === toolId)
        const bashTools = request.tools.filter(name => name === 'Bash' || name.endsWith('__Bash'))
        provider.push({ questionPresent: request.text.includes(question), bashTools, ...(result ? { result } : {}) })
        if (result) return { text: answer }
        if (bashTools.length !== 1) return { text: 'The requested command tool was not uniquely advertised.' }
        return { tools: [{ id: toolId, name: bashTools[0], input: { command: command.command, run_in_background: false } }] }
      })
      const created = await page.evaluate(({ spaceId, title }) => (window as unknown as { halo: HaloAPI }).halo.createConversation(spaceId, title), { spaceId: input.workSpaceId, title: 'New work after workspace migration' })
      expect(created.success).toBe(true)
      const conversation = created.data as { id: string; spaceId: string }
      expect(conversation.spaceId).toBe(input.workSpaceId)
      const sent = await page.evaluate(request => (window as unknown as { halo: HaloAPI }).halo.sendMessage(request), { spaceId: input.workSpaceId, conversationId: conversation.id, message: question })
      expect(sent.success).toBe(true)
      await expect.poll(async () => (await readAcceptanceConversation(page, input.workSpaceId, conversation.id)).messages.at(-1)?.content, { timeout: 45000 }).toBe(answer)
      await waitForAcceptanceIdle(page, conversation.id)
      expect(provider).toHaveLength(2)
      expect(provider.every(item => item.questionPresent && item.bashTools.length === 1)).toBe(true)
      const result = provider[1].result!
      expect(result).toMatchObject({ id: toolId, error: false })
      const target = input.spaces.find(space => space.meta.id === input.workSpaceId)!
      const workDir = realpathSync(target.meta.workingDir ?? target.path)
      const receipt = { cwd: workDir, marker: command.marker }
      expect(JSON.parse(result.text)).toEqual(receipt)
      expect(JSON.parse(readFileSync(join(workDir, command.outputName), 'utf8'))).toEqual(receipt)
      for (const directory of new Set([input.root, ...input.spaces.flatMap(space => [space.path, space.meta.workingDir ?? space.path])])) {
        if (realpathSync(directory) !== workDir) expect(existsSync(join(directory, command.outputName)), `New work must not escape into ${directory}`).toBe(false)
      }
      const stored = await readAcceptanceConversation(page, input.workSpaceId, conversation.id)
      expect(stored.messages.map(message => ({ role: message.role, content: message.content, error: message.error }))).toEqual([
        { role: 'user', content: question, error: undefined }, { role: 'assistant', content: answer, error: undefined },
      ])
      const thoughts = await page.evaluate(({ spaceId, conversationId, messageId }) => (window as unknown as { halo: HaloAPI }).halo.getMessageThoughts(spaceId, conversationId, messageId), { spaceId: input.workSpaceId, conversationId: conversation.id, messageId: stored.messages[1].id })
      expect(thoughts.success).toBe(true)
      const tools = (thoughts.data as Thought[]).filter(thought => thought.type === 'tool_use' && thought.toolName?.endsWith('Bash'))
      expect(tools).toHaveLength(1)
      expect(tools[0].toolInput).toMatchObject({ command: command.command })
      expect(tools[0].toolResult).toMatchObject({ isError: false })
      expect(JSON.parse(tools[0].toolResult!.output)).toEqual(receipt)
      observations.work = { conversation, receipt, tools }
      await inspectLegacyData(page, input, conversation)
      expect(oldHistoryIdentity(input)).toEqual(oldHistory)
      page = await acceptanceApp.restart()
      observations.afterNewWorkRestart = await inspectLegacyData(page, input, conversation)
      expect(oldHistoryIdentity(input)).toEqual(oldHistory)
      expect(await readAcceptanceConversation(page, input.workSpaceId, conversation.id)).toEqual(stored)
      expect(JSON.parse(readFileSync(join(workDir, command.outputName), 'utf8'))).toEqual(receipt)
      expect(model.exchanges).toHaveLength(2)
    } finally {
      await info.attach(`${dataset}-migration-evidence`, { body: JSON.stringify({ ...observations, provider }, null, 2), contentType: 'application/json' })
    }
  })
}
