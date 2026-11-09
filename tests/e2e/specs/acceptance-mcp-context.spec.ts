import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { McpSpec } from '../../../src/shared/apps/spec-types'
import { AnthropicProvider, createSession, readSessionToolContextMode } from '@hello-halo/agent-sdk'
import { test, expect, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { test as remoteTest } from '../fixtures/acceptance-remote'
import { startAcceptanceMcp } from '../fixtures/acceptance-mcp'
import { openMcpLibrary, scriptMcpTurn, assertMcpModelResult, isMcpTurnActive } from '../fixtures/acceptance-mcp-recovery'
import { test as registryTest, registryMcp } from '../fixtures/acceptance-registry'
import { seedManagedSpace, seedManagedConversation, openManagedConversation } from '../fixtures/acceptance-management'
import { withRejectedMcpPreferenceWrites } from '../fixtures/acceptance-mcp-context'
import { navigateToChat } from '../fixtures/helpers'

const name = 'Context preference fixture'
const description = 'Find customer orders and their delivery status.'

function binding(caseId: string, variant: Record<string, string> = {}, mode: 'none' | 'scripted' = 'none') {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId, evidence: 'app-e2e', mode, variant }) } }
}

async function install(window: Page, command: string, extra?: Partial<McpSpec['mcp_server']>) {
  const result = await window.evaluate(async ({ name, command, extra }) => {
    return (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({
      spaceId: null,
      spec: { spec_version: '1', type: 'mcp', name, version: '1.0.0', author: 'Acceptance fixture',
        description: 'A controlled service for loading preferences.',
        mcp_server: { transport: 'streamable-http', command, ...extra } },
      userConfig: { PREFERENCE_FIXTURE: 'fixture-value' },
    })
  }, { name, command, extra })
  expect(result.success).toBe(true)
  return (result.data as { appId: string }).appId
}

async function readApp(window: Page, appId: string): Promise<InstalledApp> {
  const result = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.appGet(id), appId)
  expect(result.success).toBe(true)
  return result.data as InstalledApp
}

async function openSettings(page: Page) {
  await openMcpLibrary(page)
  await page.getByRole('heading', { name, level: 3, exact: true }).click()
  const settings = page.getByRole('heading', { name: 'Halo SDK tool loading', exact: true }).locator('..')
  await expect(settings).toBeVisible()
  return settings
}

async function confirmSave(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Save shared resource changes?', exact: true })
  await expect(dialog.getByText('This changes a shared resource, not only the digital human you opened it from.', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

async function saveLifecyclePreferences(window: Page, appId: string) {
  const settings = await openSettings(window)
  await settings.getByLabel('Tool loading', { exact: true }).selectOption('eager')
  await settings.getByLabel('Capability description', { exact: true }).fill(description)
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmSave(window)
  expect((await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({
    appId, overrides: { disabledTools: ['fixture_disabled'] },
  }), appId)).success).toBe(true)
  const saved = await readApp(window, appId)
  expect(saved.userOverrides.mcpContext).toEqual({ loading: 'eager', summary: description })
  expect(saved.userOverrides.disabledTools).toEqual(['fixture_disabled'])
  return saved
}

function assertRetainedPreferences(actual: InstalledApp, before: InstalledApp) {
  expect(actual.id).toBe(before.id)
  expect(actual.userOverrides).toEqual(before.userOverrides)
  expect(actual.userConfig).toEqual(before.userConfig)
  expect(actual.permissions).toEqual(before.permissions)
  expect(actual.spec.type).toBe('mcp')
  expect((actual.spec as McpSpec).mcp_server).toEqual((before.spec as McpSpec).mcp_server)
}

async function assertPreferenceFields(page: Page) {
  const settings = page.getByRole('heading', { name: 'Halo SDK tool loading', exact: true }).locator('..')
  await expect(settings.getByLabel('Tool loading', { exact: true })).toHaveValue('eager')
  await expect(settings.getByLabel('Capability description', { exact: true })).toHaveValue(description)
}

async function editSettings(page: Page, ownerWindow: Page, appId: string) {
  const before = await readApp(ownerWindow, appId)
  expect(before.userOverrides.mcpContext).toBeUndefined()
  const settings = await openSettings(page)
  await expect(settings.getByLabel('Tool loading', { exact: true })).toHaveValue('deferred')
  await expect(settings.getByLabel('Capability description', { exact: true })).toBeEnabled()
  await expect(settings).toContainText('These settings affect Halo SDK only.')
  await settings.getByLabel('Tool loading', { exact: true }).selectOption('eager')
  await settings.getByLabel('Capability description', { exact: true }).fill(description)
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Save shared resource changes?', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await readApp(ownerWindow, appId)).userOverrides).toEqual(before.userOverrides)
  await expect(settings.getByLabel('Capability description', { exact: true })).toHaveValue(description)
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmSave(page)
  await expect.poll(async () => (await readApp(ownerWindow, appId)).userOverrides.mcpContext)
    .toEqual({ loading: 'eager', summary: description })
  await openSettings(page)
  await expect(settings.getByLabel('Tool loading', { exact: true })).toHaveValue('eager')
  await expect(settings.getByLabel('Capability description', { exact: true })).toHaveValue(description)
  await settings.getByLabel('Capability description', { exact: true }).fill('   ')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmSave(page)
  const after = await readApp(ownerWindow, appId)
  expect(after.userOverrides.mcpContext).toEqual({ loading: 'eager' })
  expect({ status: after.status, permissions: after.permissions, config: after.userConfig, spec: after.spec })
    .toEqual({ status: before.status, permissions: before.permissions, config: before.userConfig, spec: before.spec })
}

async function retryFailedSave(page: Page, ownerWindow: Page, profile: string, appId: string) {
  const before = await readApp(ownerWindow, appId)
  const settings = await openSettings(page)
  await settings.getByLabel('Tool loading', { exact: true }).selectOption('eager')
  await settings.getByLabel('Capability description', { exact: true }).fill(description)
  await withRejectedMcpPreferenceWrites(profile, appId, async () => {
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Save shared resource changes?', exact: true })
    await dialog.getByRole('button', { name: 'Confirm change', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Could not apply this change. Your draft is retained. Please retry.')
    expect(await readApp(ownerWindow, appId)).toEqual(before)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(settings.getByLabel('Tool loading', { exact: true })).toHaveValue('eager')
    await expect(settings.getByLabel('Capability description', { exact: true })).toHaveValue(description)
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  })
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmSave(page)
  await expect.poll(async () => (await readApp(ownerWindow, appId)).userOverrides.mcpContext)
    .toEqual({ loading: 'eager', summary: description })
  expect(await readApp(ownerWindow, appId)).toEqual({
    ...before, userOverrides: { ...before.userOverrides, mcpContext: { loading: 'eager', summary: description } },
  })
  await page.reload()
  await openSettings(page)
  await assertPreferenceFields(page)
}

test('desktop MCP context settings retain the draft after a real database write failure',
  binding('capabilities.mcp-context.save-failure', { client: 'desktop' }), async ({ acceptanceApp, window, model }) => {
    const service = await startAcceptanceMcp()
    try {
      const appId = await install(window, service.url)
      await retryFailedSave(window, window, acceptanceApp.profile, appId)
      expect(model.exchanges).toEqual([])
      expect(service.calls).toEqual([])
    } finally { await service.close() }
  })

remoteTest('mobile remote MCP context settings retain and retry the draft after a database write failure',
  binding('capabilities.mcp-context.save-failure', { client: 'remote-mobile' }), async ({ acceptanceApp, window, remote, model }) => {
    const service = await startAcceptanceMcp()
    try {
      const appId = await install(window, service.url)
      await remote.page.setViewportSize({ width: 390, height: 844 })
      await remote.login()
      await retryFailedSave(remote.page, window, acceptanceApp.profile, appId)
      expect(model.exchanges).toEqual([])
      expect(service.calls).toEqual([])
    } finally { await service.close() }
  })

test('desktop MCP context settings save without requiring an active conversation or healthy connection',
  binding('capabilities.mcp-context.edit', { client: 'desktop' }), async ({ window, model }, info) => {
    const service = await startAcceptanceMcp()
    service.setAvailable(false)
    try {
      const appId = await install(window, service.url)
      await editSettings(window, window, appId)
      expect(model.exchanges).toEqual([])
      expect(service.calls).toEqual([])
      await info.attach('saved-preferences', { body: JSON.stringify((await readApp(window, appId)).userOverrides), contentType: 'application/json' })
    } finally { await service.close() }
  })

remoteTest('mobile remote MCP context settings use the same persisted preferences and shared impact',
  binding('capabilities.mcp-context.edit', { client: 'remote-mobile' }), async ({ window, remote, model }, info) => {
    const service = await startAcceptanceMcp()
    service.setAvailable(false)
    try {
      const appId = await install(window, service.url)
      await remote.page.setViewportSize({ width: 390, height: 844 })
      await remote.login()
      await editSettings(remote.page, window, appId)
      const bounds = await remote.page.getByLabel('Capability description', { exact: true }).boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
      expect(model.exchanges).toEqual([])
      await remote.page.screenshot({ path: info.outputPath('mcp-context-mobile.png') })
    } finally { await service.close() }
  })

type Patch = (appId: string, overrides: Record<string, unknown>) => Promise<{ success: boolean }>
async function validateSettings(window: Page, appId: string, patch: Patch) {
  const summary = '🧩'.repeat(512)
  expect((await patch(appId, { mcpContext: { loading: 'eager', summary }, disabledTools: ['fixture_disabled'] })).success).toBe(true)
  const before = await readApp(window, appId)
  expect(before.userOverrides.mcpContext).toEqual({ loading: 'eager', summary })
  for (const mcpContext of [{ summary: '🧩'.repeat(513) }, { unknown: true }, { loading: 'automatic' }, { summary: false }, []]) {
    expect((await patch(appId, { mcpContext, notificationLevel: 'none' })).success).toBe(false)
    expect(await readApp(window, appId)).toEqual(before)
  }
  const person = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: 'halo-temp', spec: { spec_version: '1', type: 'automation', name: 'Preference validation person',
      version: '1.0.0', author: 'Acceptance fixture', description: 'A controlled person.', system_prompt: 'Wait for a request.' },
  }))
  expect(person.success).toBe(true)
  expect((await patch((person.data as { appId: string }).appId, { mcpContext: { loading: 'eager' } })).success).toBe(false)
  expect((await patch(appId, { mcpContext: { summary: null } })).success).toBe(true)
  const after = await readApp(window, appId)
  expect(after).toEqual({ ...before, userOverrides: { ...before.userOverrides, mcpContext: { loading: 'eager' } } })
}

test('desktop override API rejects malformed MCP context preferences without partial writes',
  binding('capabilities.mcp-context.validation', { client: 'desktop' }), async ({ window, model }) => {
    const service = await startAcceptanceMcp()
    try {
      const appId = await install(window, service.url)
      await validateSettings(window, appId, (appId, overrides) => window.evaluate(input =>
        (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides(input), { appId, overrides }))
      expect(model.exchanges).toEqual([])
    } finally { await service.close() }
  })

remoteTest('remote override API uses the same Unicode limits and field clearing rules',
  binding('capabilities.mcp-context.validation', { client: 'remote' }), async ({ window, remote, model }) => {
    const service = await startAcceptanceMcp()
    try {
      const appId = await install(window, service.url)
      await remote.login()
      await validateSettings(window, appId, (appId, overrides) => remote.page.evaluate(async ({ appId, overrides }) => {
        const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/overrides`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('halo_remote_token')}` },
          body: JSON.stringify(overrides),
        })
        return response.json()
      }, { appId, overrides }))
      expect(model.exchanges).toEqual([])
    } finally { await service.close() }
  })

test('MCP loading preferences survive a real application restart',
  binding('capabilities.mcp-context.retain', { lifecycle: 'restart' }), async ({ acceptanceApp, window, model }) => {
    const service = await startAcceptanceMcp()
    try {
      const appId = await install(window, service.url)
      const settings = await openSettings(window)
      await settings.getByLabel('Tool loading', { exact: true }).selectOption('eager')
      await settings.getByLabel('Capability description', { exact: true }).fill(description)
      await settings.getByRole('button', { name: 'Save', exact: true }).click()
      await confirmSave(window)
      expect((await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({
        appId, overrides: { disabledTools: ['fixture_disabled'] },
      }), appId)).success).toBe(true)
      const before = await readApp(window, appId)
      const reopened = await acceptanceApp.restart()
      const restored = await openSettings(reopened)
      await expect(restored.getByLabel('Tool loading', { exact: true })).toHaveValue('eager')
      await expect(restored.getByLabel('Capability description', { exact: true })).toHaveValue(description)
      expect(await readApp(reopened, appId)).toEqual(before)
      expect(model.exchanges).toEqual([])
    } finally { await service.close() }
  })

registryTest('MCP personal context preferences survive a real author package upgrade',
  binding('capabilities.mcp-context.retain', { lifecycle: 'author-upgrade' }), async ({ window, registry }, info) => {
    registryTest.setTimeout(120000)
    const service = await startAcceptanceMcp()
    const sourceId = registry.sources[0].id
    const first = registryMcp('context-loading-retention', name)
    first.spec.mcp_server = { transport: 'streamable-http', command: service.url }
    first.spec.store = { ...(first.spec.store as Record<string, unknown>), registry_id: sourceId }
    try {
      registry.publish(sourceId, [first])
      expect((await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.storeRefresh())).success).toBe(true)
      const installed = await window.evaluate(spec => (globalThis as unknown as { halo: HaloAPI }).halo.appInstall({
        spaceId: null, spec, userConfig: { PREFERENCE_FIXTURE: 'fixture-value' },
      }), first.spec)
      expect(installed.success).toBe(true)
      const appId = (installed.data as { appId: string }).appId
      const before = await saveLifecyclePreferences(window, appId)
      expect(before.spec.version).toBe('1.0.0')
      const next = structuredClone(first)
      next.entry.version = '1.1.0'
      next.entry.path = 'apps/context-loading-retention/1.1.0'
      next.entry.description = 'Updated author description for the same controlled connection.'
      next.spec.version = next.entry.version
      next.spec.description = next.entry.description
      registry.publish(sourceId, [next])
      expect((await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.storeRefresh())).success).toBe(true)
      const upgraded = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.storeApplyUpgrade({
        appId, mode: 'patch_minor',
      }), appId)
      expect(upgraded).toMatchObject({ success: true, data: { appId, from: '1.0.0', to: '1.1.0' } })
      const after = await readApp(window, appId)
      assertRetainedPreferences(after, before)
      expect(after.spec).toMatchObject({ version: '1.1.0', description: next.entry.description })
      expect(registry.requests.some(request => request.path === `/${sourceId}/${next.entry.path}/spec.yaml` && request.status === 200)).toBe(true)
      await window.reload()
      await openSettings(window)
      await assertPreferenceFields(window)
      assertRetainedPreferences(await readApp(window, appId), before)
      expect(service.calls).toEqual([])
      await info.attach('author-upgrade-context-retention', { body: JSON.stringify({ before, after, authorPackage: next.spec, upgrade: upgraded.data }, null, 2), contentType: 'application/json' })
    } finally { await service.close() }
  })

test('MCP context preferences follow a connection into its destination workspace',
  binding('capabilities.mcp-context.retain', { lifecycle: 'scope-move' }), async ({ window, model }, info) => {
    const service = await startAcceptanceMcp()
    try {
      const appId = await install(window, service.url)
      const destination = await seedManagedSpace(window, 'MCP context destination')
      const before = await saveLifecyclePreferences(window, appId)
      expect(before.spaceId).toBeNull()
      const moved = await window.evaluate(input => (globalThis as unknown as { halo: HaloAPI }).halo.appMoveSpace(input), {
        appId, newSpaceId: destination.id,
      })
      expect(moved.success).toBe(true)
      const after = await readApp(window, appId)
      expect(after.spaceId).toBe(destination.id)
      assertRetainedPreferences(after, before)
      await window.reload()
      await openMcpLibrary(window)
      const scope = window.getByRole('combobox', { name: 'Scope', exact: true })
      await scope.selectOption('global')
      await expect(window.getByRole('heading', { name, level: 3, exact: true })).toHaveCount(0)
      await scope.selectOption(destination.id)
      await expect(scope).toHaveValue(destination.id)
      await expect(window.getByRole('heading', { name, level: 3, exact: true })).toBeVisible()
      await window.getByRole('heading', { name, level: 3, exact: true }).click()
      await assertPreferenceFields(window)
      const restored = await readApp(window, appId)
      expect(restored.spaceId).toBe(destination.id)
      assertRetainedPreferences(restored, before)
      expect(model.exchanges).toEqual([])
      expect(service.calls).toEqual([])
      await info.attach('scope-move-context-retention', { body: JSON.stringify({ destination, before, after: restored }, null, 2), contentType: 'application/json' })
    } finally { await service.close() }
  })

test('MCP context preferences survive soft removal and explicit reinstall',
  binding('capabilities.mcp-context.retain', { lifecycle: 'reinstall' }), async ({ window, model }, info) => {
    const service = await startAcceptanceMcp()
    try {
      const appId = await install(window, service.url)
      const before = await saveLifecyclePreferences(window, appId)
      const removed = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appUninstall({ appId }), appId)
      expect(removed.success).toBe(true)
      const uninstalled = await readApp(window, appId)
      expect(uninstalled.status).toBe('uninstalled')
      assertRetainedPreferences(uninstalled, before)
      await window.reload()
      await openMcpLibrary(window)
      const removedCard = window.locator('div[role="button"]').filter({ has: window.getByRole('heading', { name, level: 3, exact: true }) })
      await expect(removedCard).toHaveCount(1)
      await removedCard.hover()
      await expect(removedCard.getByTitle('Reinstall', { exact: true })).toBeVisible()
      const reinstalled = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appReinstall({ appId }), appId)
      expect(reinstalled.success).toBe(true)
      const after = await readApp(window, appId)
      expect(after.status).toBe('active')
      assertRetainedPreferences(after, before)
      await window.reload()
      await openSettings(window)
      await assertPreferenceFields(window)
      assertRetainedPreferences(await readApp(window, appId), before)
      expect(model.exchanges).toEqual([])
      expect(service.calls).toEqual([])
      await info.attach('reinstall-context-retention', { body: JSON.stringify({ before, uninstalled, after }, null, 2), contentType: 'application/json' })
    } finally { await service.close() }
  })

test('MCP context preferences never enter a service process environment or exported specification',
  binding('capabilities.mcp-context.no-leak'), async ({ acceptanceApp, window, model }, info) => {
    const script = join(acceptanceApp.profile, 'mcp-preferences.cjs')
    const receipts = join(acceptanceApp.profile, 'mcp-preferences-receipts.jsonl')
    writeFileSync(script, `const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') {
    fs.appendFileSync(process.argv[2], JSON.stringify({
      marker: process.env.PREFERENCE_FIXTURE,
      context: process.env.mcpContext ?? null,
      loading: process.env.loading ?? null,
      summary: process.env.summary ?? null,
      descriptionLeaked: Object.values(process.env).some(value => value && value.includes(${JSON.stringify(description)}))
    }) + '\\n');
    result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'preference-fixture', version: '1.0.0' } };
  } else if (message.method === 'tools/list') result = { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`)
    const appId = await install(window, process.execPath, { transport: 'stdio', args: [script, receipts] })
    const settings = await openSettings(window)
    await settings.getByLabel('Tool loading', { exact: true }).selectOption('eager')
    await settings.getByLabel('Capability description', { exact: true }).fill(description)
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await confirmSave(window)
    const probe = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.probeMcpApp(appId), appId)
    expect(probe).toMatchObject({ success: true, result: { status: 'connected' } })
    const observations = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(observations.length).toBeGreaterThan(0)
    for (const observed of observations) expect(observed).toEqual({ marker: 'fixture-value', context: null, loading: null, summary: null, descriptionLeaked: false })
    const exported = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appExportSpec(appId), appId)
    expect(exported.success).toBe(true)
    expect(exported.data?.yaml).not.toContain('mcpContext')
    expect(exported.data?.yaml).not.toContain(description)
    expect(model.exchanges).toEqual([])
    await info.attach('service-preference-isolation', { body: JSON.stringify(observations), contentType: 'application/json' })
  })

test('Halo applies loading preferences after the current real tool finishes without losing its result',
  binding('capabilities.mcp-context.engine-scope', { engine: 'halo' }, 'scripted'), async ({ window, model }, info) => {
    const service = await startAcceptanceMcp()
    const held = service.holdNextToolCall()
    try {
      const appId = await install(window, service.url)
      await navigateToChat(window)
      const first = scriptMcpTurn(model, 'before-loading-preference')
      const turn = await sendAcceptanceMessage(window, first.question)
      await expect.poll(() => service.calls.length).toBe(1)
      expect(await isMcpTurnActive(window, turn.conversationId)).toBe(true)
      const exchange = service.exchanges.find(item => item.method === 'tools/call' && item.value === first.value)!
      const settings = await openSettings(window)
      const handshakes = service.exchanges.filter(item => item.method === 'initialize').length
      await settings.getByLabel('Tool loading', { exact: true }).selectOption('eager')
      await settings.getByLabel('Capability description', { exact: true }).fill(description)
      await settings.getByRole('button', { name: 'Save', exact: true }).click()
      await confirmSave(window)
      expect((await readApp(window, appId)).userOverrides.mcpContext).toEqual({ loading: 'eager', summary: description })
      expect(await isMcpTurnActive(window, turn.conversationId)).toBe(true)
      expect(exchange).toMatchObject({ status: null, completed: false, cancelled: false })
      expect(service.exchanges.filter(item => item.method === 'initialize')).toHaveLength(handshakes)
      held.release()
      await navigateToChat(window)
      await expect(window.locator('.message-assistant').last()).toContainText(first.answer)
      await waitForAcceptanceIdle(window, turn.conversationId)
      assertMcpModelResult(first, true)
      expect(first.requests).toHaveLength(3)
      for (const request of first.requests) expect(request.body.tools).toEqual(first.requests[0].body.tools)
      expect(first.requests[0].tools.some(tool => tool.endsWith('__echo_acceptance'))).toBe(false)
      expect(exchange).toMatchObject({ status: 200, completed: true, cancelled: false })
      const eager = scriptMcpTurn(model, 'after-loading-preference')
      expect((await sendAcceptanceMessage(window, eager.question)).conversationId).toBe(turn.conversationId)
      await expect(window.locator('.message-assistant').last()).toContainText(eager.answer)
      await waitForAcceptanceIdle(window, turn.conversationId)
      assertMcpModelResult(eager, true)
      expect(eager.requests).toHaveLength(2)
      expect(eager.requests[0].tools.some(tool => tool.endsWith('__echo_acceptance'))).toBe(true)
      const restoredSettings = await openSettings(window)
      await restoredSettings.getByLabel('Tool loading', { exact: true }).selectOption('deferred')
      await restoredSettings.getByRole('button', { name: 'Save', exact: true }).click()
      await confirmSave(window)
      await navigateToChat(window)
      const deferred = scriptMcpTurn(model, 'after-return-to-deferred')
      expect((await sendAcceptanceMessage(window, deferred.question)).conversationId).toBe(turn.conversationId)
      await expect(window.locator('.message-assistant').last()).toContainText(deferred.answer)
      await waitForAcceptanceIdle(window, turn.conversationId)
      assertMcpModelResult(deferred, true)
      expect(deferred.requests).toHaveLength(3)
      expect(deferred.requests[0].tools.some(tool => tool.endsWith('__echo_acceptance'))).toBe(false)
      expect(JSON.stringify(deferred.requests[0].body)).toContain(description)
      expect(service.calls).toEqual([first, eager, deferred].map(script => ({ value: script.value, failed: false })))
      await info.attach('loading-preference-boundary', { body: JSON.stringify({ first, eager, deferred, exchange }), contentType: 'application/json' })
    } finally { held.release(); await service.close() }
  })

test('an older Halo conversation keeps direct tool calls while a new conversation uses discovery',
  binding('capabilities.mcp-context.legacy', {}, 'scripted'), async ({ acceptanceApp, window, model }, info) => {
    const service = await startAcceptanceMcp()
    const seed = 'Remember the historical reference cedar-legacy.'
    const answer = 'The historical reference cedar-legacy is retained.'
    let nativePath = ''
    let legacyId = ''
    let originalNative = Buffer.alloc(0)
    try {
      const space = await seedManagedSpace(window, 'Legacy tool context workspace')
      const appId = await install(window, service.url)
      const eagerPreference = await window.evaluate(appId => (globalThis as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({
        appId, overrides: { mcpContext: { loading: 'eager' } },
      }), appId)
      expect(eagerPreference.success).toBe(true)
      const conversation = await seedManagedConversation(window, space.id, 'Original tool context', [
        { role: 'user', content: seed }, { role: 'assistant', content: answer },
      ])
      model.respond(() => ({ text: answer }))
      const cwd = space.workingDir ?? space.path
      let page = await acceptanceApp.restart(async profile => {
        const config = JSON.parse(readFileSync(join(profile, '.halo', 'config.json'), 'utf8'))
        expect(config.agent.configDirMode).toBe('custom')
        const env = { HOME: profile, USERPROFILE: profile, CLAUDE_CONFIG_DIR: config.agent.customConfigDir as string }
        const legacy = await createSession({ cwd, env, provider: new AnthropicProvider({ apiKey: 'local-scripted-endpoint', baseUrl: model.url }),
          model: 'gpt-4o', tools: [], settingSources: [], persistSession: true, maxTurns: 2,
          turnEndChecks: { completion: false, openWork: false }, systemPrompt: 'Keep the historical reference.' })
        try {
          legacyId = legacy.sessionId
          await legacy.send(seed)
          for await (const message of legacy.stream()) if (message.type === 'result') {
            expect(message.is_error).toBe(false)
            break
          }
        } finally { await legacy.close() }
        expect(await readSessionToolContextMode(legacyId, { cwd, env })).toBe('full')
        const records = (readdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true }) as string[]).filter(file => file.endsWith(`${legacyId}.jsonl`))
        expect(records).toHaveLength(1)
        nativePath = join(env.CLAUDE_CONFIG_DIR, records[0])
        originalNative = readFileSync(nativePath)
        const filename = join(space.path, '.halo', 'conversations', `${conversation.id}.json`)
        const stored = JSON.parse(readFileSync(filename, 'utf8'))
        stored.engineId = 'halo'
        stored.sessionId = legacyId
        stored.engineBinding = { version: 1, engineId: 'halo', sessionId: legacyId }
        writeFileSync(filename, JSON.stringify(stored))
      })
      const settings = await openSettings(page)
      await settings.getByLabel('Tool loading', { exact: true }).selectOption('deferred')
      await settings.getByLabel('Capability description', { exact: true }).fill(description)
      await settings.getByRole('button', { name: 'Save', exact: true }).click()
      await confirmSave(page)
      expect((await readApp(page, appId)).userOverrides.mcpContext).toEqual({ loading: 'deferred', summary: description })
      const legacy = scriptMcpTurn(model, 'legacy-full-tools')
      await openManagedConversation(page, conversation.title, space.id)
      expect((await sendAcceptanceMessage(page, legacy.question)).conversationId).toBe(conversation.id)
      await expect(page.locator('.message-assistant').last()).toContainText(legacy.answer)
      await waitForAcceptanceIdle(page, conversation.id)
      assertMcpModelResult(legacy, true)
      expect(legacy.requests).toHaveLength(2)
      expect(legacy.requests[0].tools.some(tool => tool.endsWith('__echo_acceptance'))).toBe(true)
      expect(legacy.requests[0].tools).not.toContain('ToolSearch')
      expect(legacy.requests[0].text).toContain(seed)
      const stored = JSON.parse(readFileSync(join(space.path, '.halo', 'conversations', `${conversation.id}.json`), 'utf8'))
      expect(stored.engineBinding).toMatchObject({ engineId: 'halo', sessionId: legacyId })
      expect(stored.messages.slice(0, conversation.messages.length)).toEqual(conversation.messages)
      expect(readFileSync(nativePath).subarray(0, originalNative.length)).toEqual(originalNative)
      const next = await seedManagedConversation(page, space.id, 'New tool context', [])
      page = await acceptanceApp.restart()
      const deferred = scriptMcpTurn(model, 'new-deferred-tools')
      await openManagedConversation(page, next.title, space.id, { empty: true })
      await sendAcceptanceMessage(page, deferred.question)
      await expect(page.locator('.message-assistant').last()).toContainText(deferred.answer)
      await waitForAcceptanceIdle(page, next.id)
      assertMcpModelResult(deferred, true)
      expect(deferred.requests).toHaveLength(3)
      expect(deferred.requests[0].tools.some(tool => tool.endsWith('__echo_acceptance'))).toBe(false)
      expect(deferred.requests[0].tools).toEqual(expect.arrayContaining(['ToolSearch', 'CallTool']))
      expect(service.calls).toEqual([legacy, deferred].map(script => ({ value: script.value, failed: false })))
      await info.attach('legacy-and-new-tool-contexts', { body: JSON.stringify({ legacyId, legacy, deferred, calls: service.calls }), contentType: 'application/json' })
    } finally { await service.close() }
  })
