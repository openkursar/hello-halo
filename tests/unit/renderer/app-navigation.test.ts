import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../../src/renderer/api', () => ({ api: { isRemoteMode: () => false } }))
vi.mock('../../../src/renderer/api/transport', () => ({ isCapacitor: () => false }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: { getState: () => ({}) } }))
import { useAppStore } from '../../../src/renderer/stores/app.store'

beforeEach(() => useAppStore.setState({ view: 'space', returnTo: null }))

it('a nav entry you are already on leaves back pointing where you came from', () => {
  const { navigate, navigateBack } = useAppStore.getState()
  navigate('settings')
  navigate('settings')
  expect(useAppStore.getState().returnTo).toBe('space')
  navigateBack('space')
  expect(useAppStore.getState().view).toBe('space')
})

it('back consumes its target so a second back falls through to the caller default', () => {
  const { navigate, navigateBack } = useAppStore.getState()
  navigate('apps')
  navigateBack('space')
  expect(useAppStore.getState().view).toBe('space')
  navigateBack('space')
  expect(useAppStore.getState().view).toBe('space')
})
