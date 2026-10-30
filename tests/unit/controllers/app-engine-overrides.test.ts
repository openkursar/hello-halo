import { beforeEach, expect, it, vi } from 'vitest'
import type { InstalledApp } from '../../../src/shared/apps/app-types'

const state = vi.hoisted(() => ({
  app: null as InstalledApp | null,
  defaultEngine: 'halo',
  validate: vi.fn(),
  save: vi.fn(),
}))
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: () => ({ getApp: () => state.app, updateOverrides: state.save }) }))
vi.mock('../../../src/main/apps/runtime', () => ({ getAppRuntime: () => null }))
vi.mock('../../../src/main/services/agent', () => ({ assertEngineSourceSelection: state.validate, resolveDefaultEngine: async () => state.defaultEngine }))

import { updateOverrides } from '../../../src/main/controllers/app.controller'

beforeEach(() => {
  state.app = { id: 'person', spec: { type: 'automation' }, userOverrides: { engineId: 'halo', modelSourceId: 'existing-account', modelId: 'existing-model' } } as InstalledApp
  state.defaultEngine = 'halo'
  state.validate.mockReset().mockResolvedValue(undefined)
  state.save.mockReset()
})

it('checks the merged engine, account and model before saving one changed field', async () => {
  expect(await updateOverrides('person', { engineId: 'codex' })).toEqual({ success: true, data: undefined })
  expect(state.validate).toHaveBeenCalledWith('codex', { engineId: 'codex', modelSourceId: 'existing-account', modelId: 'existing-model' })
  expect(state.save).toHaveBeenCalledWith('person', { engineId: 'codex' })
})

it('does not persist an incompatible combination or replace its account and model', async () => {
  state.validate.mockRejectedValueOnce(new Error('Unsupported account protocol'))
  expect(await updateOverrides('person', { engineId: 'codex' })).toMatchObject({ success: false, error: 'Unsupported account protocol' })
  expect(state.save).not.toHaveBeenCalled()
  expect(state.app?.userOverrides).toEqual({ engineId: 'halo', modelSourceId: 'existing-account', modelId: 'existing-model' })
})

it('allows unrelated settings even when a stored engine and account are incompatible', async () => {
  state.validate.mockRejectedValue(new Error('Unsupported account protocol'))
  expect(await updateOverrides('person', { notificationLevel: 'all' })).toMatchObject({ success: true })
  expect(state.validate).not.toHaveBeenCalled()
  expect(state.save).toHaveBeenCalledWith('person', { notificationLevel: 'all' })
})

it('checks a reset against the available default while preserving the account and model', async () => {
  state.defaultEngine = 'anthropic'
  expect(await updateOverrides('person', { engineId: null })).toMatchObject({ success: true })
  expect(state.validate).toHaveBeenCalledWith('anthropic', { modelSourceId: 'existing-account', modelId: 'existing-model' })
})

it('checks model and account changes against the saved engine', async () => {
  expect(await updateOverrides('person', { modelSourceId: 'other', modelId: 'other-model' })).toMatchObject({ success: true })
  expect(state.validate).toHaveBeenCalledWith('halo', { engineId: 'halo', modelSourceId: 'other', modelId: 'other-model' })
})

it('does not save a choice validated against an account another edit has replaced', async () => {
  state.validate.mockImplementationOnce(async () => { state.app!.userOverrides.modelSourceId = 'concurrent-account' })
  expect(await updateOverrides('person', { engineId: 'codex' })).toMatchObject({ success: false, error: expect.stringContaining('changed while saving') })
  expect(state.save).not.toHaveBeenCalled()
})

it('does not save a reset validated against an outdated default', async () => {
  state.validate.mockImplementationOnce(async () => { state.defaultEngine = 'codex' })
  expect(await updateOverrides('person', { engineId: null })).toMatchObject({ success: false, error: expect.stringContaining('changed while saving') })
  expect(state.save).not.toHaveBeenCalled()
})

it('rejects malformed selections before preflight and persistence', async () => {
  expect(await updateOverrides('person', { engineId: 'unknown' })).toMatchObject({ success: false, error: 'Invalid engineId' })
  expect(state.validate).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
})
