/**
 * Goal support for a conversation's composer: the "+" menu row, goal mode,
 * and the shelf above the card. Returns nothing when the running engine keeps
 * no goals, so the composer shows no goal controls.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { Target, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import { useConversationGoal, useGoalStore, useGoalSupported, type GoalInput } from '../../stores/goal.store'
import { useGoalUiStore } from '../../stores/goal-ui.store'
import type { ImageAttachment } from '../../types'
import type { ContentReference } from '../../../shared/types/content-reference'
import { GoalShelf } from './GoalShelf'
import { notifyGoalUpdateFailed, pendingGoal, saveGoal } from './goal-actions'
import { parseGoalDraft } from './parseGoalDraft'
import type { GoalComposerConfig } from './types'

interface UseGoalComposerOptions {
  spaceId: string | null | undefined
  conversationId: string | null | undefined
  /** The composer's draft key; goal mode is remembered per draft. */
  draftKey: string | undefined
  isGenerating: boolean
  /** Send the message with the goal attached. Resolves whether it was sent. */
  send: (
    content: string,
    images: ImageAttachment[] | undefined,
    thinkingEnabled: boolean,
    goal: GoalInput,
    references?: ContentReference[],
  ) => Promise<boolean>
}

function GoalModeChip({ onExit }: { onExit: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1 px-3.5 pt-2.5 -mb-1.5">
      <span role="status" className="inline-flex items-center gap-1 h-6 px-2 rounded-md bg-primary/[0.12] text-accent-on-dark text-xs font-medium">
        <Target size={13} aria-hidden />
        <span aria-hidden>{t('Goal')}</span>
        <span className="sr-only">{t('Goal mode')}</span>
      </span>
      <button
        type="button"
        onClick={onExit}
        aria-label={t('Exit goal mode')}
        title={t('Exit goal mode')}
        className="inline-flex items-center justify-center h-8 w-8 sm:h-6 sm:w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <X size={13} />
      </button>
    </div>
  )
}

/**
 * Send a message that sets the goal. Main applies the goal before the turn
 * starts, so the model sees it from the first step. A failed send may still
 * have reached main, so the goal is re-read rather than assumed unchanged.
 */
async function sendWithGoal(
  spaceId: string,
  conversationId: string,
  input: GoalInput,
  send: () => Promise<boolean>
): Promise<boolean> {
  const store = useGoalStore.getState()
  const rollback = store.applyOptimistic(conversationId, pendingGoal(input), { unseen: false })
  const sent = await send()
  if (sent) return true
  rollback()
  notifyGoalUpdateFailed()
  void useGoalStore.getState().load(spaceId, conversationId)
  return false
}

export function useGoalComposer({
  spaceId,
  conversationId,
  draftKey,
  isGenerating,
  send,
}: UseGoalComposerOptions): GoalComposerConfig | undefined {
  const { t } = useTranslation()
  const supported = useGoalSupported()
  const goal = useConversationGoal(conversationId)
  const modeKey = draftKey ?? conversationId ?? null
  const active = useGoalUiStore((s) => (modeKey ? s.composerGoalMode.has(modeKey) : false))
  const sendKeyMode = useAppStore((s) => s.config?.chat?.sendKeyMode ?? 'enter')

  useEffect(() => {
    if (supported && spaceId && conversationId) void useGoalStore.getState().load(spaceId, conversationId)
  }, [supported, spaceId, conversationId])

  const setMode = useCallback((on: boolean) => {
    if (modeKey) useGoalUiStore.getState().setComposerGoalMode(modeKey, on)
  }, [modeKey])

  const submit = useCallback(async (text: string, images: ImageAttachment[] | undefined, thinkingEnabled: boolean, references?: ContentReference[]) => {
    const input = parseGoalDraft(text)
    if (!input || !spaceId || !conversationId) return false
    setMode(false)
    // Mid-turn, the goal goes to the running turn, which picks it up at its next step.
    const accepted = isGenerating
      ? await saveGoal(spaceId, conversationId, input)
      : await sendWithGoal(spaceId, conversationId, input, () => send(text, images, thinkingEnabled, input, references?.length ? references : undefined))
    if (!accepted) setMode(true)
    return accepted
  }, [spaceId, conversationId, isGenerating, send, setMode])

  const hasShelf = !!(supported && spaceId && conversationId)
  const shelf = useMemo(() => hasShelf && spaceId && conversationId ? (
    <GoalShelf
      spaceId={spaceId}
      conversationId={conversationId}
      running={isGenerating}
      onNewGoal={() => setMode(true)}
    />
  ) : null, [hasShelf, spaceId, conversationId, isGenerating, setMode])

  const hasActiveGoal = goal?.status === 'active'
  const finishedGoal = !!goal && !hasActiveGoal

  // Stable while nothing it shows changes, so the memoized composer can skip renders.
  return useMemo<GoalComposerConfig | undefined>(() => {
    if (!hasShelf || !spaceId || !conversationId) return undefined
    return {
      active,
      menuItem: {
        label: hasActiveGoal ? t('Edit goal') : finishedGoal ? t('Set a new goal') : t('Set a goal'),
        description: t('Halo keeps working toward it; context compaction never loses it'),
        onSelect: () => {
          if (hasActiveGoal) void canvasLifecycle.openGoal(spaceId, conversationId)
          else setMode(true)
        },
      },
      exit: () => setMode(false),
      chip: <GoalModeChip onExit={() => setMode(false)} />,
      placeholder: t('Describe the outcome you want Halo to reach…'),
      sendTitle: isGenerating
        ? t('Set goal — Halo picks it up at its next step')
        : sendKeyMode === 'ctrl-enter' ? t('Set goal and start — Ctrl+Enter') : t('Set goal and start — Enter'),
      canSubmit: (text) => parseGoalDraft(text) !== null,
      submit,
      shelf,
    }
  }, [hasShelf, spaceId, conversationId, active, hasActiveGoal, finishedGoal, t, setMode, isGenerating, sendKeyMode, submit, shelf])
}
