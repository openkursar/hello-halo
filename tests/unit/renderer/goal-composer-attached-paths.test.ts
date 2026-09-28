/**
 * A goal sent with attached paths: the paths ride on the message the model
 * reads, while the goal itself is parsed from the typed text alone.
 */

import { expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ ui: { composerGoalMode: new Set<string>(['d']), setComposerGoalMode: () => {} } }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useCallback: (fn: any) => fn, useMemo: (compute: any) => compute(), useEffect: () => {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: any) => select({ config: null }) }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: { openGoal: vi.fn() } }))
vi.mock('../../../src/renderer/stores/goal.store', () => ({
  useConversationGoal: () => null,
  useGoalSupported: () => true,
  useGoalStore: { getState: () => ({ load: vi.fn(), applyOptimistic: () => () => {} }) },
}))
vi.mock('../../../src/renderer/stores/goal-ui.store', () => ({ useGoalUiStore: Object.assign((select: any) => select(env.ui), { getState: () => env.ui }) }))
vi.mock('../../../src/renderer/components/goal/GoalShelf', () => ({ GoalShelf: () => null }))
vi.mock('../../../src/renderer/components/goal/goal-actions', () => ({ notifyGoalUpdateFailed: vi.fn(), pendingGoal: (input: any) => input, saveGoal: vi.fn(async () => true) }))

import { useGoalComposer } from '../../../src/renderer/components/goal/useGoalComposer'
import { splitAttachedPaths } from '../../../src/shared/attached-paths'

it('sends the goal text with the paths appended, and parses the goal from the text only', async () => {
  const send = vi.fn(async () => true)
  const composer = useGoalComposer({ spaceId: 's', conversationId: 'c', draftKey: 'd', isGenerating: false, send })!
  const paths = [{ path: '/Users/me/Docs/q3.pdf', isDirectory: false }, { path: '/Users/me/site', isDirectory: true }]

  expect(await composer.submit('Ship the Q3 report', undefined, true, paths)).toBe(true)

  const [content, images, thinking, goal] = send.mock.calls[0] as unknown as [string, unknown, boolean, { objective: string }]
  expect(splitAttachedPaths(content)).toEqual({
    text: 'Ship the Q3 report',
    paths: [{ path: '/Users/me/Docs/q3.pdf', isDirectory: false }, { path: '/Users/me/site/', isDirectory: true }],
  })
  expect(images).toBeUndefined()
  expect(thinking).toBe(true)
  expect(goal.objective).not.toContain('attached_paths')
})
