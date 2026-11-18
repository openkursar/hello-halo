import type { HaloAPI } from '../../../src/preload'
import type { SubagentModelSettings } from '../../../src/shared/types/subagent-models'
import { test, expect } from '../fixtures/acceptance-remote-desktop'
import { acceptance } from '../fixtures/acceptance-app'
import { assignmentSettings, storedAssignmentConfig, openAssignmentPanel } from '../fixtures/acceptance-subagent-models'
import { navigateToSettings } from '../fixtures/helpers'

test.use({ diagnoseShutdown: true })

test('owner web assignment writes share real persistence and validation with IPC', acceptance('models.subagent-profiles.configuration', { transport: 'http' }), async ({ remoteDesktop, managementApp, window }) => {
  test.setTimeout(180000)
  const added = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesAddSource({
    id: 'remote-config-local', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    name: 'Local remote-config account', provider: 'openai', authType: 'api-key', apiUrl: 'http://127.0.0.1:9', apiKey: 'local-unused-config-key',
    model: 'gpt-4o', availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }],
  }))
  expect(added.success).toBe(true)
  const config = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
  const sourceId = (config.data as { aiSources: { sources: Array<{ id: string }> } }).aiSources.sources[0].id
  expect(sourceId).toBe('remote-config-local')
  const original = storedAssignmentConfig(managementApp.profile)
  await remoteDesktop.login()
  await navigateToSettings(remoteDesktop.page)
  const panel = await openAssignmentPanel(remoteDesktop.page)
  await expect(panel.getByText('Not configured', { exact: true })).toHaveCount(3)
  const request = async (action: string, input?: unknown) => remoteDesktop.page.evaluate(async ({ action, input }) => {
    const token = localStorage.getItem('halo_remote_token')
    const response = await fetch(`/api/subagent-models${action ? `/${action}` : ''}`, {
      method: action ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(action ? { body: JSON.stringify(input) } : {}),
    })
    return { status: response.status, value: await response.json() as { success: boolean; data?: SubagentModelSettings; code?: string; error?: string } }
  }, { action, input })
  const initial = await request('')
  expect(initial.value.success).toBe(true)
  const small = initial.value.data!.profiles.find(profile => profile.id === 'builtin:small')!
  const configured = await request('update', { id: small.id, expectedRevision: small.revision, description: 'Owner web extraction', target: { kind: 'model', sourceId, modelId: 'gpt-4o' } })
  expect(configured.value.success, configured.value.error).toBe(true)
  expect(configured.value.data!.selectionMode).toBe('inherit')
  const created = await request('create', { name: 'Remote verifier', description: 'Verify fields', target: { kind: 'model', sourceId, modelId: 'gpt-4o' } })
  expect(created.value.success).toBe(true)
  const custom = created.value.data!.profiles.find(profile => profile.kind === 'custom')!
  const renamed = await request('update', { id: custom.id, expectedRevision: custom.revision, name: 'Remote reviewer', description: custom.description, target: custom.target })
  expect(renamed.value.success).toBe(true)
  const automatic = await request('set-selection-mode', { selectionMode: 'task', expectedRevision: renamed.value.data!.revision })
  expect(automatic.value.success).toBe(true)
  const revision = automatic.value.data!.profiles.find(profile => profile.id === custom.id)!.revision
  const deleted = await request('delete', { id: custom.id, expectedRevision: revision })
  expect(deleted.value.success).toBe(true)
  const boundSmall = deleted.value.data!.profiles.find(profile => profile.id === small.id)!
  const cleared = await request('clear-builtin', { id: small.id, expectedRevision: boundSmall.revision })
  expect(cleared.value.success).toBe(true)
  expect(cleared.value.data!.selectionMode).toBe('inherit')
  expect(cleared.value.data!.profiles).toHaveLength(3)
  expect(await assignmentSettings(window)).toEqual(cleared.value.data)
  expect({ ...storedAssignmentConfig(managementApp.profile), settings: undefined }).toEqual({ ...original, settings: undefined })
  await remoteDesktop.page.reload()
  const reread = await request('')
  expect(reread.value.data).toEqual(cleared.value.data)
})
