/**
 * TerminalViewer — live xterm.js view of a main-process pty session.
 *
 * The pty lives in the main process (single source of truth). This viewer:
 *  - replays the session's recent raw output on mount (faithful colors/cursor),
 *  - streams live output from `terminal:data`,
 *  - sends keystrokes back to the pty (desktop: IPC; remote: WS for low latency,
 *    HTTP fallback) — full-duplex human takeover,
 *  - keeps the pty size in sync via the fit addon + ResizeObserver.
 *
 * A soft border highlight indicates when the AI is actively writing, so the two
 * parties never surprise each other (Ctrl+C always reaches the pty).
 */

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../../../api'
import { isElectron } from '../../../api/transport'
import { useTerminalStore } from '../../../stores/terminal.store'
import { useTranslation } from '../../../i18n'
import type { TabState } from '../../../services/canvas-lifecycle'
import { noteTerminalInput } from '../../../services/tool-session-telemetry'
import { buildTheme, getMinimumContrastRatio } from '../../../lib/terminal-theme'
import { latchTerminalEnd, type TerminalEndState } from '../../../lib/terminal-liveness'
import { useCanvasActions } from '../../../hooks/useCanvasLifecycle'
import {
  attachTerminalReferences,
  notifyTerminalOutputMissing,
  openCommentCard,
  openCommentCardAtComposer,
  revealInTerminal,
  terminalTopRect,
} from '../../references'
import { useViewerResources } from '../viewer-resources'

interface TerminalViewerProps {
  tab: TabState
}

/**
 * Rendered chars accumulated before sending a flow-control ack. Must stay ≤ the
 * main-side low watermark or a paused pty could never resume.
 */
const CHAR_COUNT_ACK_SIZE = 5000

export function TerminalViewer({ tab }: TerminalViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const resources = useViewerResources()
  const sessionId = tab.terminalSessionId

  const aiWriting = useTerminalStore(s => (sessionId ? s.aiWriting.has(sessionId) : false))
  const sessionInfo = useTerminalStore(s => (sessionId ? s.sessions.get(sessionId) : undefined))
  // Session gone entirely (e.g. app restarted — ptys don't survive restarts)
  const [missing, setMissing] = useState(false)
  const [ended, setEnded] = useState<TerminalEndState | null>(null)

  useEffect(() => {
    setEnded(prev => latchTerminalEnd(prev, sessionInfo))
  }, [sessionInfo])

  const dead = ended !== null || missing

  // Gate keyboard input inside the (mount-scoped) effect via a ref.
  const deadRef = useRef(dead)
  deadRef.current = dead
  // The tab title at the moment output is pointed at, read inside the mount-scoped effect.
  const titleRef = useRef(tab.title)
  titleRef.current = tab.title
  const tabIdRef = useRef(tab.id)
  tabIdRef.current = tab.id
  // Opened to show output from a card in the composer: the composer keeps the caret.
  const keepFocusRef = useRef(false)
  keepFocusRef.current = !!tab.reveal?.keepFocus
  // Set once the replay is written: output searched for before that is not there yet.
  const [replayed, setReplayed] = useState(false)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const scope = resources.scope()
    const term = scope.add(new Terminal({
      fontFamily: 'Menlo, Monaco, "Cascadia Code", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 10000,
      theme: buildTheme(),
      minimumContrastRatio: getMinimumContrastRatio(),
      allowProposedApi: true,
    }))
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit

    let disposed = false

    // Send helper: WS in remote mode (low latency), IPC on desktop, HTTP fallback.
    // No-ops once the session has exited (dead terminals are read-only replays).
    const sendInput = (data: string) => {
      if (deadRef.current) return
      noteTerminalInput(sessionId, data)
      if (isElectron()) {
        void api.terminalInput(sessionId, data)
      } else if (!api.sendWsMessage('terminal-input', { sessionId, data })) {
        void api.terminalInput(sessionId, data)
      }
    }
    const sendResize = (cols: number, rows: number) => {
      if (deadRef.current) return
      if (isElectron()) {
        void api.terminalResize(sessionId, cols, rows)
      } else if (!api.sendWsMessage('terminal-resize', { sessionId, cols, rows })) {
        void api.terminalResize(sessionId, cols, rows)
      }
    }

    // Keyboard → pty
    scope.add(term.onData(sendInput))

    // Selected output can be handed to the chat.
    scope.add(attachTerminalReferences(term, () => ({ kind: 'terminal', title: titleRef.current, sessionId })))

    // Flow control: register as a live consumer, then acknowledge chars AFTER
    // xterm has rendered them (the write callback), in CHAR_COUNT_ACK_SIZE
    // batches. Main pauses the pty when this viewer's unacked backlog passes the
    // high watermark — bounding memory end-to-end when a command floods output
    // faster than the renderer can draw.
    void api.terminalAttach(sessionId)
    let unackedChars = 0
    const ackRendered = (charCount: number) => {
      if (deadRef.current) return
      unackedChars += charCount
      if (unackedChars >= CHAR_COUNT_ACK_SIZE) {
        const n = unackedChars
        unackedChars = 0
        void api.terminalAck(sessionId, n)
      }
    }
    const writeLive = (data: string) => {
      term.write(data, () => ackRendered(data.length))
    }

    // Live output → xterm (filtered by sessionId). Until the replay snapshot
    // has been written, live chunks are buffered rather than written directly:
    // the replay is a point-in-time snapshot and must land BEFORE any live data
    // that arrives during its async round-trip, or the two interleave out of
    // order (the "open a running task" corruption). Once flushed we stream live.
    let replayApplied = false
    const pendingLive: string[] = []
    scope.add(api.onTerminalData((payload: unknown) => {
      const e = payload as { sessionId: string; data: string }
      if (e.sessionId !== sessionId || disposed) return
      if (replayApplied) writeLive(e.data)
      else pendingLive.push(e.data)
    }))

    // Replay recent output, then flush buffered live output, then fit + report
    // initial size. A failed replay means the session no longer exists in the
    // main process (e.g. the app restarted — ptys don't survive restarts): mark
    // the tab as ended.
    void api.getTerminalReplay(sessionId).then((res) => {
      if (disposed) return
      if (res.success && res.data) {
        const replay = res.data as { data: string }
        if (replay.data) term.write(replay.data)
      } else {
        setMissing(true)
      }
      // Flush live chunks that arrived during the replay round-trip, in arrival
      // order, then switch to direct streaming.
      replayApplied = true
      for (const chunk of pendingLive) writeLive(chunk)
      pendingLive.length = 0
      // xterm parses writes asynchronously; an empty write's callback runs after everything before it.
      term.write('', () => {
        if (!disposed) setReplayed(true)
      })
      try {
        fit.fit()
        sendResize(term.cols, term.rows)
      } catch {
        // container not measured yet — ResizeObserver will retry
      }
      if (!keepFocusRef.current) term.focus()
    })

    // Keep pty sized to the container.
    const ro = scope.add(new ResizeObserver(() => {
      if (disposed) return
      try {
        fit.fit()
        sendResize(term.cols, term.rows)
      } catch {
        // ignore transient zero-size
      }
    }))
    ro.observe(containerRef.current)

    // xterm.js caches theme colors; toggling the class alone does not repaint.
    const themeObserver = scope.add(new MutationObserver(() => {
      if (disposed || !termRef.current) return
      termRef.current.options.theme = buildTheme()
      termRef.current.options.minimumContrastRatio = getMinimumContrastRatio()
    }))
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    // Released first: stop gating flow control the moment this consumer goes
    // away, or an unacked backlog would keep the pty paused with nobody to ack.
    scope.add(() => {
      disposed = true
      void api.terminalDetach(sessionId)
      termRef.current = null
      fitRef.current = null
    })

    return () => scope.dispose()
    // The session is the tab's for life, and the viewer mounts once per tab.
  }, [resources])

  // Going back to output a reference points at, once the replay is in the buffer.
  const { consumeReveal } = useCanvasActions()
  const reveal = tab.reveal
  useEffect(() => {
    if (!reveal || !replayed) return
    const term = termRef.current
    if (!term) return
    const shown = reveal.quote ? revealInTerminal(term, reveal.quote) : null
    if (!shown) notifyTerminalOutputMissing()
    // A comment gone back to opens beside its output, or at the top when the output is gone, so it can still be edited.
    if (reveal.commentId) {
      const at = shown ?? terminalTopRect(term)
      if (at) openCommentCard(reveal.commentId, at)
      else openCommentCardAtComposer(reveal.commentId)
    }
    consumeReveal(tabIdRef.current, reveal.seq)
  }, [reveal, replayed, consumeReveal])

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        {/* No session bound to this tab */}
      </div>
    )
  }

  const sendKey = (data: string) => {
    if (dead) return
    if (isElectron()) {
      void api.terminalInput(sessionId, data)
    } else if (!api.sendWsMessage('terminal-input', { sessionId, data })) {
      void api.terminalInput(sessionId, data)
    }
    termRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-full w-full bg-card">
      {/* Ended banner — the terminal below stays as a read-only replay */}
      {dead && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs
          bg-muted/60 text-muted-foreground border-b border-border">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
          {missing
            ? t('Session ended (output no longer available)')
            : ended?.exitCode !== null && ended?.exitCode !== undefined
              ? t('Session ended (exit {{code}})', { code: ended.exitCode })
              : t('Session ended')}
        </div>
      )}

      <div
        className={`flex-1 min-h-0 p-2 transition-shadow duration-200 ${
          aiWriting ? 'ring-2 ring-inset ring-primary/60' : ''
        } ${dead ? 'opacity-80' : ''}`}
      >
        <div ref={containerRef} className="h-full w-full" />
      </div>

      {/* Touch key bar — soft keyboards lack these keys. Mobile only (<640px). */}
      {!dead && (
        <div className="shrink-0 flex sm:hidden items-center gap-1 px-2 py-1.5 border-t border-border bg-muted/30 overflow-x-auto">
          {([
            ['Esc', '\x1b'],
            ['Tab', '\t'],
            ['Ctrl+C', '\x03'],
            ['↑', '\x1b[A'],
            ['↓', '\x1b[B'],
            ['←', '\x1b[D'],
            ['→', '\x1b[C'],
          ] as Array<[string, string]>).map(([label, seq]) => (
            <button
              key={label}
              onClick={() => sendKey(seq)}
              className="shrink-0 px-2.5 py-1 rounded-md text-xs font-mono
                bg-muted text-foreground/80 active:bg-primary/20 transition-colors"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
