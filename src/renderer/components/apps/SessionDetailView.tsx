/**
 * SessionDetailView
 *
 * Live + interactive viewer for an automation run, rendered through the shared
 * MessageList shell (identical to the main chat), but fed from the run's JSONL
 * transcript rather than the live agent event bus.
 *
 * Why JSONL, not events: a scheduled run is a headless execution that produces a
 * transcript; "watching" it is a read over that transcript. The run writes each
 * block to its JSONL as it completes (app:get-session reads it back). While the
 * run is live we poll that transcript so new steps appear incrementally — the
 * same behaviour the old polling view had, but now through the unified shell.
 * Because the run emits no renderer events, the ~99% of runs nobody watches cost
 * the renderer nothing, and the poll only runs while this view is open.
 *
 * - Live detection is authoritative from the app runtime status (running +
 *   runningRunId === runId), broadcast via app:status_changed.
 * - While live, the input box sends a supplement via app:inject-run; the AI
 *   absorbs it at the next tool boundary, so a user can steer a run mid-flight.
 * - When not live the view is read-only over the final transcript; a Continue
 *   button is offered for runs that ended prematurely (report_to_user never called).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, AlertCircle, Play } from 'lucide-react'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { MessageList } from '../chat/MessageList'
import type { MessageListHandle } from '../chat/MessageList'
import { ScrollToBottomButton } from '../chat/ScrollToBottomButton'
import { InputArea } from '../chat/InputArea'
import { useTranslation } from '../../i18n'
import type { Message } from '../../types'

interface SessionDetailViewProps {
  /** App ID that owns this run */
  appId: string
  /** Run ID to load session messages for */
  runId: string
}

type LoadState = 'loading' | 'loaded' | 'error' | 'empty'

/** Transcript refresh interval while a run is live (ms). */
const LIVE_POLL_INTERVAL = 2000

export function SessionDetailView({ appId, runId }: SessionDetailViewProps) {
  const { t } = useTranslation()

  const [messages, setMessages] = useState<Message[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // ── Scroll control via the shared MessageList shell (Virtuoso-based) ──
  const messageListRef = useRef<MessageListHandle>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setShowScrollButton(!atBottom)
  }, [])

  // ── Authoritative "this run is live" from the app runtime status ──
  const runtimeState = useAppsStore(s => s.appStates[appId])
  const isLive = runtimeState?.status === 'running' && runtimeState?.runningRunId === runId

  // ── Premature-termination Continue affordance ──
  const activityEntries = useAppsStore(s => s.activityEntries[appId])
  const continueApp = useAppsStore(s => s.continueApp)
  const [isContinuing, setIsContinuing] = useState(false)

  const errorEntry = activityEntries?.find(
    e => e.runId === runId && e.type === 'run_error' && e.content.error === 'report_to_user not called'
  )
  const isPrematureTermination = !!errorEntry
  const isAppBusy = runtimeState?.status === 'running' || runtimeState?.status === 'queued'

  const handleContinue = async () => {
    if (isContinuing || isAppBusy) return
    setIsContinuing(true)
    try {
      await continueApp(appId, runId)
    } finally {
      setIsContinuing(false)
    }
  }

  // ── Load persisted run messages from JSONL ──
  const loadSession = useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setLoadState('loading')
      setErrorMsg(null)
    }
    try {
      const res = await api.appGetSession(appId, runId)
      if (res.success && res.data) {
        const msgs = (res.data as Message[]) ?? []
        setMessages(msgs)
        setLoadState(prev => (msgs.length > 0 ? 'loaded' : (prev === 'loading' ? 'empty' : prev)))
      } else if (showSpinner) {
        setLoadState('empty')
      }
    } catch (err) {
      if (showSpinner) {
        console.error('[SessionDetailView] Failed to load session:', err)
        setErrorMsg(String(err))
        setLoadState('error')
      }
    }
  }, [appId, runId])

  // ── Initial load on run change ──
  useEffect(() => {
    loadSession(true)
  }, [appId, runId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── While the run is live, poll the JSONL so new steps appear incrementally ──
  // The poll exists only while this view is open AND the run is live, so unwatched
  // and finished runs incur zero cost.
  useEffect(() => {
    if (!isLive) return
    const timer = setInterval(() => loadSession(false), LIVE_POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [isLive, loadSession])

  // ── Final reload when the run finishes (live → idle) to capture the last block ──
  const prevLiveRef = useRef(isLive)
  useEffect(() => {
    if (prevLiveRef.current && !isLive) {
      loadSession(false)
    }
    prevLiveRef.current = isLive
  }, [isLive, loadSession])

  // ── Send a message to this run ──
  // Backend routes: live run → inject into the current turn; finished run →
  // resume the run's session and continue. The view doesn't need to distinguish.
  const handleSend = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Optimistic echo; the next JSONL poll/reload reconciles to the persisted copy.
    setMessages(prev => [...prev, {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    }])
    setLoadState('loaded')
    requestAnimationFrame(() => messageListRef.current?.scrollToBottom('auto'))
    api.appInjectRun(appId, runId, trimmed)
      .then(res => {
        if (!res.success) console.error('[SessionDetailView] Send failed:', res.error)
        // Pull the AI's response in promptly without waiting for the next poll tick.
        else setTimeout(() => loadSession(false), 600)
      })
      .catch(err => console.error('[SessionDetailView] Send error:', err))
  }, [appId, runId, loadSession])

  // ── Loading state ──
  if (loadState === 'loading') {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">{t('Loading session...')}</span>
        </div>
      </div>
    )
  }

  // ── Error state ──
  if (loadState === 'error') {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-2 text-muted-foreground max-w-sm text-center">
          <AlertCircle className="w-5 h-5 text-destructive" />
          <p className="text-sm">{t('Failed to load session')}</p>
          {errorMsg && <p className="text-xs text-muted-foreground/60">{errorMsg}</p>}
        </div>
      </div>
    )
  }

  // ── Empty + not live: nothing to show ──
  if (loadState === 'empty' && !isLive) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t('No messages in this session')}</p>
      </div>
    )
  }

  // ── Loaded / live: render via the shared MessageList shell ──
  // The run is headless, so there is no live store session to subscribe to:
  // messages (incl. their inline thoughts) come entirely from the polled JSONL.
  // Thought panels start expanded+maximized — the full execution timeline is the
  // point of this view. The footer slot carries either a "running" indicator or
  // the Continue affordance for premature stops.
  const footerExtra = isLive ? (
    <div className="mt-2 flex items-center gap-2 text-muted-foreground/60">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      <span className="text-xs">{t('Running…')}</span>
    </div>
  ) : (isPrematureTermination ? (
    <div className="mt-2 flex">
      <button
        onClick={handleContinue}
        disabled={isContinuing || isAppBusy}
        className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full
          bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20
          transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Play className="w-3 h-3" />
        {isContinuing ? t('Continuing…') : t('Continue')}
      </button>
    </div>
  ) : undefined)

  return (
    <div className="h-full flex flex-col">
      {/* Live indicator — container-owned bar above the shell */}
      {isLive && (
        <div className="flex items-center gap-2 mx-4 mt-4 px-2 py-1.5 rounded-md bg-green-500/10 border border-green-500/20 shrink-0">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-green-500/60 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-xs text-green-600 dark:text-green-400">{t('Running — live')}</span>
        </div>
      )}

      <div className="flex-1 relative overflow-hidden">
        <div className="h-full px-4">
          <MessageList
            key={runId}
            ref={messageListRef}
            messages={messages}
            streamingContent=""
            isGenerating={false}
            hideBrowserViewButton
            defaultThoughtsExpanded
            defaultThoughtsMaximized
            onAtBottomStateChange={handleAtBottomStateChange}
            footerExtra={footerExtra}
          />
        </div>

        <ScrollToBottomButton
          visible={showScrollButton}
          onClick={() => messageListRef.current?.scrollToBottom('auto')}
        />
      </div>

      {/* Always-on input — a run is a conversation you can keep talking to.
          Live: typing routes to onInject (mid-turn steer). Finished: a normal
          send that resumes the run. onStop is omitted so no Stop button shows. */}
      <div className="shrink-0 p-4">
        <InputArea
          onSend={handleSend}
          onInject={handleSend}
          isGenerating={isLive}
          placeholder={isLive ? t('Add a message to guide this run...') : t('Reply to continue this run...')}
        />
      </div>
    </div>
  )
}
