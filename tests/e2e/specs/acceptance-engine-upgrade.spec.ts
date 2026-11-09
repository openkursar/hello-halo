import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { conversationRow, openManagedConversation, seedManagedConversation, seedManagedSpace } from '../fixtures/acceptance-management'
import { conversationFileIdentity } from '../fixtures/acceptance-conversation-migration'

import { assertEngineDiscovery, assertNoCcRecoveryNotice, engineDiscoveryObserver } from '../fixtures/acceptance-engine-upgrade'

test.use({ startupObserver: engineDiscoveryObserver })
test.setTimeout(120000)

for (const history of ['native', 'transcript'] as const) {
  test(`ordinary upgrade continues ${history} history on Halo`, acceptance('models.engines.upgrade-space', { history }), async ({ acceptanceApp, window, model }, info) => {
    const space = await seedManagedSpace(window, 'Upgrade continuity')
    const target = await seedManagedConversation(window, space.id, 'Historical conversation', [])
    const control = await seedManagedConversation(window, space.id, 'Untouched archive', [{ role: 'user', content: 'Archive control' }])
    const file = join(space.path, '.halo', 'conversations', `${target.id}.json`)
    const controlFile = join(space.path, '.halo', 'conversations', `${control.id}.json`)
    const secret = 'cedar-8237'
    model.respond(() => ({ text: `I will remember ${secret}.` }))
    await openManagedConversation(window, target.title, space.id, { empty: true })
    await sendAcceptanceMessage(window, `Remember the reference ${secret} for the next question.`)
    await expect(window.locator('.message-assistant').last()).toContainText(secret)
    await waitForAcceptanceIdle(window, target.id)
    let before!: ReturnType<typeof conversationFileIdentity>
    let originalMessages: unknown[] = []
    let nativeSessionId!: string
    const page = await acceptanceApp.restart(profile => {
      const configFile = join(profile, '.halo', 'config.json')
      const config = JSON.parse(readFileSync(configFile, 'utf8'))
      config.agent = { ...config.agent, sdkEngine: 'anthropic', legacySdkEngine: 'anthropic', ccRuntime: { selectedPath: join(profile, 'absent-automatic-cc'), discoveryCompleted: true } }
      writeFileSync(configFile, JSON.stringify(config))
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      originalMessages = stored.messages
      expect(stored.engineBinding?.sessionId).toBeTruthy()
      nativeSessionId = stored.engineBinding.sessionId
      stored.engineId = 'anthropic'
      stored.engineBinding.engineId = 'anthropic'
      if (history === 'transcript') {
        stored.sessionId = 'missing-native-session'
        stored.engineBinding.sessionId = 'missing-native-session'
      }
      writeFileSync(file, JSON.stringify(stored))
      before = conversationFileIdentity(controlFile)
    })
    const received: boolean[] = []
    model.respond(request => {
      received.push(request.text.includes(secret))
      return { text: 'The previous reference is retained.' }
    })
    await openManagedConversation(page, target.title, space.id)
    await assertNoCcRecoveryNotice(page)
    await assertEngineDiscovery(acceptanceApp, info)
    await page.getByRole('button', { name: 'gpt-4o', exact: true }).click()
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await expect(page.getByLabel('Conversation engine', { exact: true })).toBeEnabled()
    await expect(page.getByText('Current engine: Halo SDK', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText(target.title, { exact: true }).first()).toBeVisible()
    await expect(conversationRow(page, target.title).getByText(/^(CC|Claude Code|Halo)$/)).toHaveCount(0)
    const turn = await sendAcceptanceMessage(page, 'What was the reference I asked you to remember?')
    expect(turn.conversationId).toBe(target.id)
    await expect(page.locator('.message-assistant').last()).toContainText('The previous reference is retained.')
    await waitForAcceptanceIdle(page, target.id)
    expect(received).toEqual([true])
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored.engineBinding.engineId).toBe('halo')
    if (history === 'native') expect(stored.engineBinding.sessionId).toBe(nativeSessionId)
    else expect(stored.engineBinding.sessionId).not.toBe('missing-native-session')
    expect(stored.messages.slice(0, originalMessages.length)).toEqual(originalMessages)
    expect(conversationFileIdentity(controlFile)).toEqual(before)
    const config = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8'))
    expect(config.agent.ccRuntime.selectionOrigin).toBeUndefined()
    expect(config.agent.ccRuntime.selectedPath).toContain('absent-automatic-cc')
    const logFile = join(acceptanceApp.profile, '.halo', 'logs', 'main.log')
    expect(existsSync(logFile)).toBe(true)
    const logs = readFileSync(logFile, 'utf8')
    expect(logs).not.toMatch(/External CC migration|\[CcRuntime\].*(?:Discovery|Discovering|Scanning)/i)
    if (history === 'native') expect(logs).not.toContain('continuing from Halo\'s recorded context')
    else expect(logs).toContain('continuing from Halo\'s recorded context')
    await assertEngineDiscovery(acceptanceApp, info)
    await info.attach('upgrade-routing', { body: JSON.stringify({ history, received, binding: stored.engineBinding, archiveUnchanged: true }), contentType: 'application/json' })
  })
}

test('a recorded external CC choice keeps the selected installation', acceptance('models.engines.explicit-installed'), async ({ acceptanceApp, window, model }, info) => {
  const selectedPath = process.env.HALO_ACCEPTANCE_CLAUDE_CLI
  if (!selectedPath || !existsSync(selectedPath)) throw new Error('Blocked prerequisite: configure HALO_ACCEPTANCE_CLAUDE_CLI through the acceptance runner')
  const space = await seedManagedSpace(window, 'Explicit engine')
  const target = await seedManagedConversation(window, space.id, 'Explicit CC conversation', [])
  const file = join(space.path, '.halo', 'conversations', `${target.id}.json`)
  const page = await acceptanceApp.restart(profile => {
    const configFile = join(profile, '.halo', 'config.json')
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    config.agent = { ...config.agent, sdkEngine: 'anthropic', ccRuntime: { selectedPath, selectionOrigin: 'user' } }
    writeFileSync(configFile, JSON.stringify(config))
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.engineOverride = 'anthropic'
    writeFileSync(file, JSON.stringify(stored))
  })
  model.respond(() => ({ text: 'External engine completed the turn.' }))
  await openManagedConversation(page, target.title, space.id, { empty: true })
  await sendAcceptanceMessage(page, 'Reply without using tools.')
  await expect(page.locator('.message-assistant').last()).toContainText('External engine completed the turn.')
  await waitForAcceptanceIdle(page, target.id)
  expect(model.exchanges.some(exchange => exchange.request.lastUserText.includes('Reply without using tools.'))).toBe(true)
  const availability = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(availability).toMatchObject({ success: true, data: { activeEngine: 'anthropic', degradedFrom: null } })
  expect(JSON.parse(readFileSync(file, 'utf8')).engineBinding.engineId).toBe('anthropic')
  const config = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8'))
  expect(config.agent.ccRuntime).toMatchObject({ selectedPath, selectionOrigin: 'user' })
  await assertEngineDiscovery(acceptanceApp, info, [selectedPath, realpathSync(selectedPath)])
  await info.attach('selected-external-runtime', { body: JSON.stringify({ selectedPath, engine: 'anthropic' }), contentType: 'application/json' })
})

for (const modelId of ['deepseek-v4.1-flash', 'gpt-6-astra']) {
  for (const permission of ['allowed', 'disabled'] as const) {
    test(`CC task checklist on ${modelId} with ${permission} tool`, acceptance('models.engines.cc-task-tracking', { model: modelId, permission }), async ({ acceptanceApp, window, model }, info) => {
      const selectedPath = process.env.HALO_ACCEPTANCE_CLAUDE_CLI
      if (!selectedPath || !existsSync(selectedPath)) throw new Error('Blocked prerequisite: configure HALO_ACCEPTANCE_CLAUDE_CLI through the acceptance runner')
      const space = await seedManagedSpace(window, 'Task checklist compatibility')
      const target = await seedManagedConversation(window, space.id, 'External CC task checklist', [])
      const file = join(space.path, '.halo', 'conversations', `${target.id}.json`)
      let page = await acceptanceApp.restart(profile => {
        const configFile = join(profile, '.halo', 'config.json')
        const config = JSON.parse(readFileSync(configFile, 'utf8'))
        config.agent = { ...config.agent, sdkEngine: 'anthropic', ccRuntime: { selectedPath, selectionOrigin: 'user' } }
        config.agent.disabledTools = [...(config.agent.disabledTools ?? []).filter((name: string) => name !== 'TodoWrite'), ...(permission === 'disabled' ? ['TodoWrite'] : [])]
        config.aiSources.sources[0].model = modelId
        config.aiSources.sources[0].availableModels = [{ id: modelId, name: modelId }]
        writeFileSync(configFile, JSON.stringify(config))
        const stored = JSON.parse(readFileSync(file, 'utf8'))
        stored.engineOverride = 'anthropic'
        stored.modelSourceId = config.aiSources.sources[0].id
        stored.modelId = modelId
        writeFileSync(file, JSON.stringify(stored))
      })
      const todo = { content: 'Verify the external engine checklist', status: 'completed', activeForm: 'Verifying the external engine checklist' }
      const observed: Array<{ tools: string[]; schema: unknown; toolSucceeded: boolean }> = []
      let searched = false
      let wrote = false
      model.respond(request => {
        if (!request.tools.length) return { text: 'Auxiliary response.' }
        const schema = (request.body.tools ?? []).map((tool: any) => tool.function ?? tool).find((tool: any) => tool.name === 'TodoWrite')?.parameters
        observed.push({ tools: request.tools, schema, toolSucceeded: request.toolResults.some(result => !result.error && result.text.includes('Todos have been modified successfully')) })
        if (permission === 'disabled') return { text: 'Checklist intentionally unavailable.' }
        if (!request.tools.includes('TodoWrite')) {
          if (searched || !request.tools.includes('ToolSearch')) return { text: 'Checklist missing.' }
          searched = true
          return { tools: [{ id: 'checklist-search', name: 'ToolSearch', input: { query: 'select:TodoWrite', max_results: 1 } }] }
        }
        if (!wrote) {
          wrote = true
          return { tools: [{ id: 'checklist-write', name: 'TodoWrite', input: { todos: [todo] } }] }
        }
        return { text: 'Checklist recorded.' }
      })
      await openManagedConversation(page, target.title, space.id, { empty: true })
      await sendAcceptanceMessage(page, 'Track this work in the task checklist.')
      await waitForAcceptanceIdle(page, target.id)
      expect(observed.length).toBeGreaterThan(0)
      expect(JSON.parse(readFileSync(file, 'utf8')).engineBinding.engineId).toBe('anthropic')
      expect(observed.every(request => !request.tools.some(name => ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'].includes(name)))).toBe(true)
      if (permission === 'allowed') {
        expect(observed.some(request => request.schema && (request.schema as any).properties?.todos)).toBe(true)
        expect(observed.some(request => request.toolSucceeded)).toBe(true)
        page = await acceptanceApp.restart()
        await openManagedConversation(page, target.title, space.id)
        await expect(page.locator('.message-assistant').last()).toContainText('Checklist recorded.')
        const details = page.getByRole('button', { name: /Already thought/ }).last()
        if (await details.getAttribute('aria-expanded') !== 'true') await details.click()
        await expect(page.getByText('Task plan', { exact: true })).toBeVisible()
        await expect(page.getByText(todo.content, { exact: true })).toBeVisible()
      } else {
        expect(observed.every(request => !request.tools.includes('TodoWrite'))).toBe(true)
        const calls = await page.evaluate(() => (window as unknown as { acceptanceProbe: { tools: string[] } }).acceptanceProbe.tools)
        expect(calls).not.toContain('TodoWrite')
        await expect(page.getByText('Task plan', { exact: true })).toHaveCount(0)
      }
      await info.attach('task-checklist-compatibility', { body: JSON.stringify({ modelId, permission, observed }), contentType: 'application/json' })
    })
  }
}

for (const runtime of ['installed', 'missing'] as const) {
  test(`a selected historical delegated account retains CC with ${runtime} runtime`, acceptance('models.engines.upgrade-delegated', { runtime }), async ({ acceptanceApp }, info) => {
    const selectedPath = runtime === 'installed' ? process.env.HALO_ACCEPTANCE_CLAUDE_CLI : join(acceptanceApp.profile, 'missing-delegated-cc')
    if (!selectedPath || (runtime === 'installed' && !existsSync(selectedPath))) throw new Error('Blocked prerequisite: configure HALO_ACCEPTANCE_CLAUDE_CLI through the acceptance runner')
    const page = await acceptanceApp.restart(profile => {
      const file = join(profile, '.halo', 'config.json')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.aiSources.sources.push({ id: 'historical-cli', name: 'Isolated delegated account', authType: 'delegated', provider: 'claude-cli', apiUrl: '', model: 'claude-sonnet-4-6', user: { name: 'isolated-test', uid: '' } })
      config.aiSources.currentId = 'historical-cli'
      config.agent = { ...config.agent, sdkEngine: 'anthropic', ccRuntime: { selectedPath, discoveryCompleted: true } }
      writeFileSync(file, JSON.stringify(config))
    })
    const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
    if (runtime === 'installed') expect(result).toMatchObject({ success: true, data: { activeEngine: 'anthropic', degradedFrom: null } })
    else expect(result.success).toBe(false)
    const config = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8'))
    expect(config.aiSources.currentId).toBe('historical-cli')
    expect(config.agent.ccRuntime.selectionOrigin).toBeUndefined()
    await assertEngineDiscovery(acceptanceApp, info, runtime === 'installed' ? [selectedPath, realpathSync(selectedPath)] : [selectedPath])
    await info.attach('delegated-upgrade-routing-only', { body: JSON.stringify(result), contentType: 'application/json' })
  })
}

test('an explicit unavailable CC choice is not silently replaced', acceptance('models.engines.explicit-missing'), async ({ acceptanceApp }, info) => {
  const page = await acceptanceApp.restart(profile => {
    const file = join(profile, '.halo', 'config.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.agent = { ...config.agent, sdkEngine: 'anthropic', ccRuntime: { selectedPath: join(profile, 'missing-explicit-cc'), selectionOrigin: 'user' } }
    writeFileSync(file, JSON.stringify(config))
  })
  const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getEngineAvailability())
  expect(result.success).toBe(false)
  expect(result.error).toMatch(/Claude Code|selected.*installation/i)
  expect(result.data).toBeUndefined()
  const config = JSON.parse(readFileSync(join(acceptanceApp.profile, '.halo', 'config.json'), 'utf8'))
  expect(config.agent).toMatchObject({ sdkEngine: 'anthropic', ccRuntime: { selectionOrigin: 'user' } })
  expect(config.agent.ccRuntime.selectedPath).toContain('missing-explicit-cc')
  await assertEngineDiscovery(acceptanceApp, info, [config.agent.ccRuntime.selectedPath])
  await info.attach('explicit-choice-retained', { body: JSON.stringify(result), contentType: 'application/json' })
})
