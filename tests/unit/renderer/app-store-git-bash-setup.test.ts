/**
 * Finishing the Git Bash setup page loads the app's settings as their
 * snapshot, as startup does. Startup stops at that page before loading them;
 * without the stamp, every save later in the session would go unchecked
 * against failed reads of the config file.
 */

import { it, expect, vi, afterEach } from 'vitest'

const { httpRequest } = vi.hoisted(() => ({ httpRequest: vi.fn() }))

vi.mock('../../../src/renderer/api', async () => {
  const { configApi } = await import('../../../src/renderer/api/config.api')
  return { api: { ...configApi, isRemoteMode: () => false } }
})
vi.mock('../../../src/renderer/api/transport', () => ({
  isElectron: () => typeof window !== 'undefined' && 'halo' in window,
  isCapacitor: () => false,
  httpRequest,
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: { getState: () => ({}) } }))

import { useAppStore } from '../../../src/renderer/stores/app.store'
import { configApi } from '../../../src/renderer/api/config.api'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('loads the settings with their stamp, so later saves carry it', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const setConfig = vi.fn(async () => ({ success: true }))
  // The config file could not be read when the settings were loaded.
  const getConfig = vi.fn(async () => ({
    success: true,
    data: { isFirstLaunch: true, aiSources: { version: 2, currentId: null, sources: [] } },
    configEpoch: -1,
  }))
  vi.stubGlobal('window', Object.assign(new EventTarget(), { halo: { getConfig, setConfig } }))

  await useAppStore.getState().completeGitBashSetup(false)

  // The skip is remembered before any settings are loaded, so it has no stamp.
  expect(setConfig).toHaveBeenNthCalledWith(1, { gitBash: { skipped: true, installed: false, path: null } }, undefined)
  expect(useAppStore.getState().view).toBe('setup')

  await configApi.setConfig({ imChannels: { instances: [] } })
  expect(setConfig).toHaveBeenLastCalledWith({ imChannels: { instances: [] } }, -1)
})
