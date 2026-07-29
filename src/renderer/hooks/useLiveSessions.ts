/**
 * useLiveSessions — aggregates the AI's live, human-viewable background resources
 * into one source-agnostic model for the LiveSessionsHeader, and exposes the
 * imperative controls (`open`, `stop`) the tray invokes on them.
 *
 * A "live session" is a long-lived resource the AI drives that has its own
 * surface in the Canvas and a lifecycle decoupled from whether that surface is
 * open (terminal pty sessions today; AI browser views next). This hook is the
 * seam that lets a single tray perceive, reveal, and stop every kind of
 * autonomous AI work through one consistent control — regardless of source.
 *
 * The `open`/`stop` actions perform imperative orchestration (space resolution,
 * view switching, Canvas tab creation) rather than just reading state. This is
 * deliberate: there is exactly one consumer (LiveSessionsHeader), and co-locating
 * the navigation with the session model keeps the reveal/stop contract in the
 * same place the session identity lives.
 */

import { useTerminalStore } from '../stores/terminal.store'
import { useAIBrowserStore } from '../stores/ai-browser.store'
import { useSpaceStore } from '../stores/space.store'
import { useAppStore } from '../stores/app.store'
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
  /**
   * Reveal a session's surface in the Canvas. Returns false when no target
   * space can be resolved — callers must surface that failure (e.g. a toast)
   * rather than silently swallowing it, otherwise the tray reproduces the
   * very symptom #266 was about: a click that does nothing visible.
   */
  open: (session: LiveSession) => boolean
  /** Stop the underlying resource (terminates the process/view). */
  stop: (session: LiveSession) => Promise<void>
}

export function useLiveSessions(): LiveSessionsApi {
  const { t } = useTranslation()

  const terminalSessionsMap = useTerminalStore(s => s.sessions)
  const aiWriting = useTerminalStore(s => s.aiWriting)
  const openTerminalInCanvas = useTerminalStore(s => s.openInCanvas)
  const killTerminalSession = useTerminalStore(s => s.killSession)

  // The terminal registry is process-global (all spaces), but the tray belongs
  // to the space you're in: an AI terminal kept alive in another space must not
  // leak into this one's tray — it reappears when you return. The AI browser
  // view is a process-global singleton (no per-space instances), so it needs no
  // filter.
  const currentSpaceId = useSpaceStore(s => s.currentSpace?.id)

  // AI browser: the interactive singleton drives one active view at a time.
  // Its lifecycle (active-view / view-gone) is reflected in the store, keyed to
  // the exact viewId — the same identity used to reveal the live view.
  const aiViewId = useAIBrowserStore(s => s.activeViewId)
  const aiUrl = useAIBrowserStore(s => s.activeUrl)
  const aiTitle = useAIBrowserStore(s => s.activeTitle)
  const aiOperating = useAIBrowserStore(s => s.isOperating)
  const aiLastActivityAt = useAIBrowserStore(s => s.lastActivityAt)

  // Terminal source: every running session the AI has operated (aiTouched),
  // whoever opened it. A user terminal the AI later drove can outlive its
  // closed tab, so the tray is where it stays perceivable and stoppable. A pure
  // user terminal the AI never touched is closed with its tab and never lands
  // here.
  const terminalSessions: LiveSession[] = [...terminalSessionsMap.values()]
    .filter(s => s.state === 'running' && s.aiTouched && s.spaceId === currentSpaceId)
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

  const open = (session: LiveSession): boolean => {
    // Resolve a target space before navigating. currentSpace is null on pages
    // that never mount SpaceSelector (e.g. Apps) — nothing clears it on
    // navigation, it's simply never set there. Without a target, landing in
    // the Space shell would be a dead end, so we fail loudly instead.
    const spaceStore = useSpaceStore.getState()
    const target = spaceStore.currentSpace ?? spaceStore.haloSpace
    if (!target) return false
    if (spaceStore.currentSpace?.id !== target.id) {
      spaceStore.setCurrentSpace(target)
    }
    if (useAppStore.getState().view !== 'space') {
      useAppStore.getState().setView('space')
    }
    // Reconcile the Canvas's space identity BEFORE creating the tab. When the
    // user is coming from a non-Space view whose last Canvas space differs from
    // the target, SpacePage's enterSpace effect would otherwise fire after the
    // tab is opened and closeAll() it — reproducing the "click does nothing"
    // symptom #266 was about. Calling enterSpace here makes SpacePage's later
    // call a no-op (previousSpaceId === spaceId), so the freshly opened tab
    // survives the navigation.
    canvasLifecycle.enterSpace(target.id)
    if (session.kind === 'terminal') {
      openTerminalInCanvas(session.id, session.title)
    } else {
      // Attach the exact AI-driven BrowserView (same WebContents).
      void canvasLifecycle.attachAIBrowserView(session.id, aiUrl || '', session.title)
    }
    return true
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
