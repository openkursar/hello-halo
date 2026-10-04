/**
 * A goal sent with cards: the cards ride on the message as references, while
 * the goal itself is parsed from the typed text alone.
 */

import { expect, it, vi } from 'vitest'
import type { ContentReference } from '../../../src/shared/types/content-reference'

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

const references: ContentReference[] = [
  { id: 'r1', source: { kind: 'path', path: '/Users/me/Docs/q3.pdf', isDirectory: false } },
  { id: 'r2', source: { kind: 'file', path: '/repo/src/a.ts', precision: 'lines' }, range: { startLine: 3, endLine: 4 }, quote: 'x', note: 'tidy' },
]

it('sends the goal text with the cards as references, and parses the goal from the text only', async () => {
  const send = vi.fn(async () => true)
  const composer = useGoalComposer({ spaceId: 's', conversationId: 'c', draftKey: 'd', isGenerating: false, send })!

  expect(await composer.submit('Ship the Q3 report', undefined, true, references)).toBe(true)

  const [content, images, thinking, goal, sent] = send.mock.calls[0] as unknown as [string, unknown, boolean, { objective: string }, ContentReference[]]
  expect(content).toBe('Ship the Q3 report')
  expect(images).toBeUndefined()
  expect(thinking).toBe(true)
  expect(sent).toEqual(references)
  expect(goal.objective).toBe('Ship the Q3 report')
})

it('a goal with no cards sends no references', async () => {
  const send = vi.fn(async () => true)
  const composer = useGoalComposer({ spaceId: 's', conversationId: 'c', draftKey: 'd', isGenerating: false, send })!
  await composer.submit('Ship it', undefined, true, [])
  expect((send.mock.calls[0] as unknown[])[4]).toBeUndefined()
})
