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

/** Read a theme HSL triplet CSS var and wrap it as a canvas-parseable color. */
function themeColor(varName: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return raw ? `hsl(${raw})` : fallback
}

function buildTheme(): Record<string, string> {
  return {
    background: themeColor('--card', '#1e1e1e'),
    foreground: themeColor('--card-foreground', '#d4d4d4'),
    cursor: themeColor('--primary', '#ffffff'),
    cursorAccent: themeColor('--card', '#1e1e1e'),
    selectionBackground: themeColor('--primary', '#264f78'),
  }
}

interface TerminalViewerProps {
  tab: TabState
}

export function TerminalViewer({ tab }: TerminalViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionId = tab.terminalSessionId

  const aiWriting = useTerminalStore(s => (sessionId ? s.aiWriting.has(sessionId) : false))
  const sessionInfo = useTerminalStore(s => (sessionId ? s.sessions.get(sessionId) : undefined))
  // Session gone entirely (e.g. app restarted — ptys don't survive restarts)
  const [missing, setMissing] = useState(false)

  const exited = sessionInfo?.state === 'exited'
  const dead = exited || missing

  // Gate keyboard input inside the (mount-scoped) effect via a ref.
  const deadRef = useRef(dead)
  deadRef.current = dead

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Cascadia Code", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 10000,
      theme: buildTheme(),
      allowProposedApi: true,
    })
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
    const dataSub = term.onData(sendInput)

    // Live output → xterm (filtered by sessionId). Until the replay snapshot
    // has been written, live chunks are buffered rather than written directly:
    // the replay is a point-in-time snapshot and must land BEFORE any live data
    // that arrives during its async round-trip, or the two interleave out of
    // order (the "open a running task" corruption). Once flushed we stream live.
    let replayApplied = false
    const pendingLive: string[] = []
    const unsubData = api.onTerminalData((payload: unknown) => {
      const e = payload as { sessionId: string; data: string }
      if (e.sessionId !== sessionId || disposed) return
      if (replayApplied) term.write(e.data)
      else pendingLive.push(e.data)
    })

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
      for (const chunk of pendingLive) term.write(chunk)
      pendingLive.length = 0
      try {
        fit.fit()
        sendResize(term.cols, term.rows)
      } catch {
        // container not measured yet — ResizeObserver will retry
      }
      term.focus()
    })

    // Keep pty sized to the container.
    const ro = new ResizeObserver(() => {
      if (disposed) return
      try {
        fit.fit()
        sendResize(term.cols, term.rows)
      } catch {
        // ignore transient zero-size
      }
    })
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      dataSub.dispose()
      unsubData()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

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
            : sessionInfo?.exitCode !== null && sessionInfo?.exitCode !== undefined
              ? `${t('Session ended')} (exit ${sessionInfo.exitCode})`
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
