/**
 * TerminalCloseGuard — decides what happens to a pty when its terminal tab is
 * closed.
 *
 * The pty lives in the main process and outlives its tab by design, so closing a
 * tab is not the same as ending the process. This guard resolves that ambiguity:
 *  - a pure user terminal the AI never touched is terminated with its tab (a
 *    terminal behaves like iTerm/VS Code for the user's own sessions);
 *  - a terminal the AI has operated (aiTouched — AI-created, or a user terminal
 *    the AI later drove) prompts the user, because silently killing it could cut
 *    off in-flight autonomous work; the choice is keep-in-background (stays in
 *    the live-sessions tray, reclaimable) or terminate.
 *
 * It registers the terminal close policy on canvasLifecycle so every path
 * funnels through one place: single-tab close (tab X, middle-click, ⌘W, context
 * menu) prompts; bulk teardown (closeAll, space switch) disposes silently —
 * terminate the user's own terminals, keep AI-operated ones alive in the tray.
 * Mounted once at the app shell (App.tsx), not inside the canvas or a page,
 * so the policy is registered before any click-handler-driven closeAll — the
 * live-sessions tray's open() lands in closeAll while no page has mounted
 * yet, so the policy must outlive page lifecycle.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TerminalSquare } from 'lucide-react'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import { useTerminalStore } from '../../stores/terminal.store'
import { useTranslation } from '../../i18n'

interface PendingClose {
  sessionId: string
  title: string
  resolve: (proceed: boolean) => void
}

export function TerminalCloseGuard() {
  const { t } = useTranslation()
  const [pending, setPending] = useState<PendingClose | null>(null)
  // Mirror for cleanup: resolve any in-flight prompt if we unmount mid-decision.
  const pendingRef = useRef<PendingClose | null>(null)
  pendingRef.current = pending

  useEffect(() => {
    const unregister = canvasLifecycle.setTerminalClosePolicy({
      // Deliberate single-tab close: prompt for AI-operated sessions.
      confirmSingleClose: async (sessionId) => {
        const store = useTerminalStore.getState()
        const info = store.sessions.get(sessionId)

        // No live process behind this tab (already exited, or unknown after a
        // restart): just close the tab.
        if (!info || info.state !== 'running') return true

        // The user's own terminal the AI never touched: closing the tab ends it.
        if (!info.aiTouched) {
          await store.killSession(sessionId)
          return true
        }

        // AI-operated: let the user decide keep-background vs terminate.
        return new Promise<boolean>((resolve) => {
          setPending((prev) => {
            // A second close request while a prompt is open (double-click,
            // another tab) replaces it; settle the displaced caller as
            // cancelled so its await never hangs.
            prev?.resolve(false)
            return { sessionId, title: info.title, resolve }
          })
        })
      },

      // Bulk teardown (closeAll / space switch): no prompt. Terminate the user's
      // own terminals (their tab was the only handle); keep AI-operated ones
      // running — they stay reachable in the live-sessions tray. Silent: a
      // failure during teardown must not pop a toast over a navigation the user
      // didn't directly request — the session is already going away.
      disposeOnBulkClose: async (sessionId) => {
        const store = useTerminalStore.getState()
        const info = store.sessions.get(sessionId)
        if (info && info.state === 'running' && !info.aiTouched) {
          await store.killSession(sessionId, { silent: true })
        }
      },
    })

    return () => {
      unregister()
      pendingRef.current?.resolve(false)
    }
  }, [])

  // Escape cancels, Enter takes the safe default (keep in background). Bound only
  // while the prompt is open.
  useEffect(() => {
    if (!pending) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      // Own the keystroke so Escape dismisses the prompt without also collapsing
      // the canvas (its ⌘W/Escape handler listens on window, one hop out).
      e.preventDefault()
      e.stopPropagation()
      pending.resolve(e.key === 'Enter')
      setPending(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [pending])

  if (!pending) return null

  const settle = (proceed: boolean) => {
    pending.resolve(proceed)
    setPending(null)
  }

  const keepInBackground = () => settle(true)

  const terminate = async () => {
    await useTerminalStore.getState().killSession(pending.sessionId)
    settle(true)
  }

  const cancel = () => settle(false)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={cancel}
    >
      <div
        className="relative w-full max-w-md mx-4 bg-background border border-border rounded-xl shadow-xl p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-5 space-y-2">
          <p className="text-sm font-medium text-foreground">{t('This terminal has been used by AI')}</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('Keeping it in the background lets the AI keep using it; closing completely ends the process.')}
          </p>
          <span className="inline-flex items-center gap-1.5 max-w-full px-2 py-0.5 rounded-md bg-secondary text-xs font-mono text-muted-foreground">
            <TerminalSquare className="w-3 h-3 shrink-0" />
            <span className="truncate">{pending.title}</span>
          </span>
        </div>

        {/* Stacked full-width actions: robust to any label length/language
            (a narrow dialog can't fit three long labels in a row). Primary on
            top, destructive middle, dismiss last. */}
        <div className="flex flex-col gap-2">
          <button
            onClick={keepInBackground}
            className="w-full px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('Keep running in background')}
          </button>
          <button
            onClick={terminate}
            className="w-full px-4 py-2 text-sm rounded-lg text-destructive hover:bg-destructive/10 transition-colors"
          >
            {t('Close completely')}
          </button>
          <button
            onClick={cancel}
            className="w-full px-4 py-2 text-sm rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            {t('Cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
