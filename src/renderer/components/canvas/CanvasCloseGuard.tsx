/**
 * CanvasCloseGuard — what closing canvas tabs ends, and the one question asked
 * before it ends the AI's work.
 *
 * Closing the AI's tab really ends it: its terminal's process, or the page it
 * opened. Nothing is kept in a background. So:
 *  - one tab (×, ⌘W, middle-click, context menu): the AI's tab asks once, with
 *    what ending it means; the user's own terminal ends with its tab, unasked;
 *  - several (close canvas, close others, close to the right): the user's own
 *    close and the AI's work stays, unasked; only when the AI's work is all
 *    that is closing does it ask once whether to end all of it;
 *  - a removed space: everything its tabs ran ends, unasked.
 * A client that cannot end the AI's page (remote web) never closes its tab.
 *
 * Registered on canvasLifecycle from the pages that host the canvas, so it
 * holds even while the canvas is collapsed.
 */

import { useEffect, useRef, useState } from 'react'
import { canvasLifecycle, type TabState } from '../../services/canvas-lifecycle'
import { createCloseDecisions, type EndOutcome } from '../../services/ai-work-close'
import { useNotificationStore } from '../../stores/notification.store'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { NON_FILE_CONTENT_META } from './content-type-meta'
import i18n, { useTranslation } from '../../i18n'

/** How many tab names the bulk question lists before "and N more". */
const LISTED_TABS = 5

type Prompt =
  | { kind: 'one'; tab: TabState; operating: boolean; resolve: (confirmed: boolean) => void }
  | { kind: 'many'; tabs: TabState[]; resolve: (confirmed: boolean) => void }

function settleAsCancelled(prompt: Prompt): void {
  prompt.resolve(false)
}

/** Tells the user why what they closed is still open; the tab stays where it was. */
function reportNotEnded(outcomes: readonly EndOutcome[]): void {
  const failed = outcomes.filter((outcome): outcome is Extract<EndOutcome, { ended: false }> => !outcome.ended)
  if (failed.length === 0) return
  const reason = failed[0].reason
  const body =
    reason === 'in-use' ? i18n.t('Another conversation is using this page right now, so it was left open.')
    : reason === 'not-owned' ? i18n.t('This page was not opened by the AI, so it was left open.')
    : i18n.t('It may still be running. Try again.')
  useNotificationStore.getState().show({
    id: 'ai-work-close-error',
    title: i18n.t('Could not close it'),
    body,
    variant: 'error',
    duration: 6000,
  })
}

export function CanvasCloseGuard() {
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  // Mirror for cleanup: settle an open question if the guard unmounts mid-decision.
  const promptRef = useRef<Prompt | null>(null)
  promptRef.current = prompt

  useEffect(() => {
    const ask = (next: Prompt) => setPrompt(previous => {
      // A second close while a question is open replaces it; the first caller is answered "cancel".
      if (previous) settleAsCancelled(previous)
      return next
    })

    const policy = createCloseDecisions({
      confirmOne: (tab, operating) => new Promise<boolean>(resolve => ask({ kind: 'one', tab, operating, resolve })),
      confirmEndAll: tabs => new Promise<boolean>(resolve => ask({ kind: 'many', tabs: [...tabs], resolve })),
      reportNotEnded,
    })

    const unregister = canvasLifecycle.setClosePolicy(policy)
    return () => {
      unregister()
      if (promptRef.current) settleAsCancelled(promptRef.current)
    }
  }, [])

  if (!prompt) return null

  const finish = () => setPrompt(null)

  if (prompt.kind === 'one') {
    return (
      <SingleCloseQuestion
        tab={prompt.tab}
        operating={prompt.operating}
        onAnswer={confirmed => { prompt.resolve(confirmed); finish() }}
      />
    )
  }
  return <EndAllQuestion tabs={prompt.tabs} onAnswer={confirmed => { prompt.resolve(confirmed); finish() }} />
}

function SingleCloseQuestion({ tab, operating, onAnswer }: { tab: TabState; operating: boolean; onAnswer: (confirmed: boolean) => void }) {
  const { t } = useTranslation()
  const copy = tab.type === 'terminal'
    ? {
        title: t('End this terminal?'),
        message: t('The AI used this terminal. Closing it ends the process running in it.'),
        confirm: t('End and close'),
      }
    : {
        title: t('Close this page?'),
        message: operating
          ? t('The AI is working on it right now; closing it interrupts what it is doing.')
          : t('The AI opened this page; what is on it will not be kept after closing.'),
        confirm: t('Close page'),
      }
  return (
    <ConfirmDialog
      title={copy.title}
      message={copy.message}
      confirmLabel={copy.confirm}
      cancelLabel={t('Cancel')}
      variant="danger"
      confirmOnEnter={false}
      onConfirm={() => onAnswer(true)}
      onCancel={() => onAnswer(false)}
    />
  )
}

function EndAllQuestion({ tabs, onAnswer }: { tabs: TabState[]; onAnswer: (confirmed: boolean) => void }) {
  const { t } = useTranslation()
  const listed = tabs.slice(0, LISTED_TABS)
  const more = tabs.length - listed.length
  return (
    <ConfirmDialog
      title={t('End the {{count}} tabs the AI is still using?', { count: tabs.length })}
      details={(
        <ul className="space-y-1.5 pt-1">
          {listed.map(tab => {
            const meta = NON_FILE_CONTENT_META[tab.type]
            return (
              <li key={tab.id} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {meta && <meta.icon className={`h-3.5 w-3.5 shrink-0 opacity-80 ${meta.color}`} strokeWidth={1.5} />}
                <span className="truncate">{tab.title}</span>
              </li>
            )
          })}
          {more > 0 && <li className="text-xs text-muted-foreground">{t('and {{count}} more', { count: more })}</li>}
        </ul>
      )}
      confirmLabel={t('End all')}
      cancelLabel={t('Cancel')}
      variant="danger"
      confirmOnEnter={false}
      onConfirm={() => onAnswer(true)}
      onCancel={() => onAnswer(false)}
    />
  )
}
