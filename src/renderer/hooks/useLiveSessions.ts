/**
 * useLiveSessions — aggregates the AI's live, human-viewable background resources
 * into one source-agnostic model for the LiveSessionsHeader.
 *
 * A "live session" is a long-lived resource the AI drives that has its own
 * surface in the Canvas and a lifecycle decoupled from whether that surface is
 * open (terminal pty sessions today; AI browser views next). This hook is the
 * seam that lets a single tray perceive, reveal, and stop every kind of
 * autonomous AI work through one consistent control — regardless of source.
 */

import { useTerminalStore } from '../stores/terminal.store'
import { useAIBrowserStore } from '../stores/ai-browser.store'
import { canvasLifecycle } from '../services/canvas-lifecycle'
import { api } from '../api'
import { useTranslation } from '../i18n'

export type LiveSessionKind = 'terminal' | 'browser'

export interface LiveSession {
  id: string
  kind: LiveSessionKind
  title: string
  /** AI is actively driving it right now — drives the pulse indicator. */
  busy: boolean
  lastActivityAt: number
}

export interface LiveSessionsApi {
  /** Running AI sessions, most-recently-active first. */
  sessions: LiveSession[]
  /** Whether any session is being actively driven right now. */
  busy: boolean
  /** Reveal a session's surface in the Canvas. */
  open: (session: LiveSession) => void
  /** Stop the underlying resource (terminates the process/view). */
  stop: (session: LiveSession) => Promise<void>
}

export function useLiveSessions(): LiveSessionsApi {
  const { t } = useTranslation()

  const terminalSessionsMap = useTerminalStore(s => s.sessions)
  const aiWriting = useTerminalStore(s => s.aiWriting)
  const openTerminalInCanvas = useTerminalStore(s => s.openInCanvas)
  const killTerminalSession = useTerminalStore(s => s.killSession)

  // AI browser: the interactive singleton drives one active view at a time.
  // Its lifecycle (active-view / view-gone) is reflected in the store, keyed to
  // the exact viewId — the same identity used to reveal the live view.
  const aiViewId = useAIBrowserStore(s => s.activeViewId)
  const aiUrl = useAIBrowserStore(s => s.activeUrl)
  const aiTitle = useAIBrowserStore(s => s.activeTitle)
  const aiOperating = useAIBrowserStore(s => s.isOperating)
  const aiLastActivityAt = useAIBrowserStore(s => s.lastActivityAt)

  // Terminal source: AI-owned running sessions only. User-opened terminals are
  // already represented by their own Canvas tab; the tray surfaces autonomous
  // AI work, not the user's own sessions.
  const terminalSessions: LiveSession[] = [...terminalSessionsMap.values()]
    .filter(s => s.state === 'running' && s.owner === 'ai')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map(s => ({
      id: s.id,
      kind: 'terminal' as const,
      title: s.title,
      busy: aiWriting.has(s.id),
      lastActivityAt: s.lastActivityAt,
    }))

  // Browser source: present iff the AI currently holds a live view.
  const browserSessions: LiveSession[] = aiViewId
    ? [{
        id: aiViewId,
        kind: 'browser' as const,
        title: aiTitle || hostnameOf(aiUrl) || t('AI Browser'),
        busy: aiOperating,
        lastActivityAt: aiLastActivityAt,
      }]
    : []

  const sessions = [...browserSessions, ...terminalSessions]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const busy = sessions.some(s => s.busy)

  const open = (session: LiveSession) => {
    if (session.kind === 'terminal') {
      openTerminalInCanvas(session.id, session.title)
    } else {
      // Attach the exact AI-driven BrowserView (same WebContents).
      void canvasLifecycle.attachAIBrowserView(session.id, aiUrl || '', session.title)
    }
  }

  const stop = async (session: LiveSession) => {
    if (session.kind === 'terminal') {
      await killTerminalSession(session.id)
    } else {
      // Destroying the view routes through browser:destroy, which clears the AI
      // singleton's active view and broadcasts view-gone (the store then drops it).
      await api.destroyBrowserView(session.id)
    }
  }

  return { sessions, busy, open, stop }
}

/** Best-effort hostname for a display label; null when the URL is unusable. */
function hostnameOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
