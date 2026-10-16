/**
 * A changed model list reported by main replaces only the AI sources the app
 * keeps, and a burst of reports costs one follow-up read, not one per report.
 */

import { it, expect, vi } from 'vitest'

const { getConfig } = vi.hoisted(() => ({ getConfig: vi.fn() }))

vi.mock('../../../src/renderer/api', () => ({ api: { getConfig } }))
vi.mock('../../../src/renderer/api/transport', () => ({ isCapacitor: () => false }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: { getState: () => ({}) } }))

import { useAppStore } from '../../../src/renderer/stores/app.store'
import type { HaloConfig } from '../../../src/renderer/types'

function sources(model: string) {
  return { version: 2, currentId: 's', sources: [{ id: 's', model, availableModels: [{ id: model, name: model }] }] }
}

it('replaces only the AI sources and collapses overlapping reloads into one follow-up read', async () => {
  useAppStore.setState({ config: { appearance: { theme: 'dark' }, aiSources: sources('old') } as unknown as HaloConfig })

  let release!: () => void
  getConfig
    .mockImplementationOnce(() => new Promise(done => { release = () => done({ success: true, data: { aiSources: sources('first') } }) }))
    .mockResolvedValue({ success: true, data: { aiSources: sources('latest'), appearance: { theme: 'light' } } })

  const first = useAppStore.getState().reloadAiSources()
  const second = useAppStore.getState().reloadAiSources()
  const third = useAppStore.getState().reloadAiSources()
  release()
  await Promise.all([first, second, third])

  expect(getConfig).toHaveBeenCalledTimes(2)
  const config = useAppStore.getState().config as unknown as Record<string, any>
  expect(config.aiSources.sources[0].model).toBe('latest')
  expect(config.appearance.theme).toBe('dark')
})

it('keeps the current sources when the read fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  useAppStore.setState({ config: { aiSources: sources('kept') } as unknown as HaloConfig })
  getConfig.mockReset().mockRejectedValue(new Error('offline'))

  await useAppStore.getState().reloadAiSources()

  const config = useAppStore.getState().config as unknown as Record<string, any>
  expect(config.aiSources.sources[0].model).toBe('kept')
})
