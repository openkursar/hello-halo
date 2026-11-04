/**
 * The command palette's quick-jump conversations come from the current space
 * only, so each row names that space rather than implying a wider scope.
 */

import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  chat: {
    currentSpaceId: 'space-a',
    spaceStates: new Map([['space-a', { conversations: [{ id: 'c1', title: 'Plan', updatedAt: '2026-11-01' }] }]])
  }
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useMemo: (fn: () => unknown) => fn()
}))
vi.mock('@/stores/chat.store', () => ({
  useChatStore: (select: (s: typeof state.chat) => unknown) => select(state.chat),
  usePulseItems: () => [{ conversationId: 'p1', title: 'Pulse', spaceId: 'space-b', updatedAt: '2026-11-02' }]
}))
vi.mock('@/stores/apps.store', () => ({ useAppsStore: (select: (s: { apps: [] }) => unknown) => select({ apps: [] }) }))
vi.mock('@/stores/tlon.store', () => ({ useTlonStore: (select: (s: { kbs: [] }) => unknown) => select({ kbs: [] }) }))
vi.mock('@/stores/space.store', () => ({
  useSpaceNameResolver: () => (id: string) => id === 'space-a' ? 'Workspace A' : 'Workspace B'
}))
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))

import { useQuickJumpCandidates } from '../../../src/renderer/components/search/useQuickJumpCandidates'

describe('useQuickJumpCandidates', () => {
  it('labels each conversation with the space it comes from', () => {
    const items = useQuickJumpCandidates()
    expect(items.find(item => item.type === 'conv')).toMatchObject({ spaceId: 'space-a', meta: 'Workspace A' })
    expect(items.find(item => item.type === 'task')).toMatchObject({ spaceId: 'space-b', meta: 'Workspace B' })
  })
})
