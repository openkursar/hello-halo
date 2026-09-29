/**
 * useLiveSessions — aggregates the AI's live, human-viewable background resources
 * into one source-agnostic model for the LiveSessionsHeader, and exposes the
 * reveal/stop controls the tray invokes on them.
 *
 * A "live session" is a long-lived resource the AI drives that has its own
 * surface in the Canvas and a lifecycle decoupled from whether that surface is
 * open (terminal pty sessions today; AI browser views next). This hook is the
 * seam that lets a single tray perceive, reveal, and stop every kind of
 * autonomous AI work through one consistent control — regardless of source.
 *
 * Revealing navigates as well as reads, because the tray lives in the chat
 * composer and the Canvas it reveals into belongs to the Space view. Keeping
 * that with the session model means the reveal contract sits where session
 * identity does, rather than being restated by each caller.
 */

import { useTerminalStore } from '../stores/terminal.store'
import { useAIBrowserStore, isPageInUseByOthers } from '../stores/ai-browser.store'
import { useChatStore } from '../stores/chat.store'
import { useAppsStore } from '../stores/apps.store'
import { parseNativeChatKey } from '../../shared/apps/im-keys'
import { buildBrowserLiveSessions } from './browser-live-sessions'
import { useSpaceStore } from '../stores/space.store'
import { useAppStore } from '../stores/app.store'
import { canvasLifecycle } from '../services/canvas-lifecycle'
import { api } from '../api'
import { isElectron } from '../api/transport'
import { useTranslation } from '../i18n'

export type LiveSessionKind = 'terminal' | 'browser'

export interface LiveSession {
  id: string
  kind: LiveSessionKind
  title: string
  /** AI is actively driving it right now — drives the pulse indicator. */
  busy: boolean
  lastActivityAt: number
  /** Browser pages: where to point a freshly attached canvas tab. */
  url?: string | null
  /** Whether this client can stop it (browser pages live in the desktop app only). */
  stoppable: boolean
}

export interface LiveSessionsApi {
  /** Running AI sessions, most-recently-active first. */
  sessions: LiveSession[]
  /** Whether any session is being actively driven right now. */
  busy: boolean
  /**
   * Reveal a session's surface in the Canvas, navigating to the Space view
   * first when the click came from elsewhere.
   *
   * Resolves with the tab id only once the surface is actually open. Null
   * means no space could be resolved to land in; callers must say so rather
   * than drop it — a click that does nothing visible is the symptom this
   * control exists to avoid.
   */
  open: (session: LiveSession) => Promise<string | null>
  /** Stop the underlying resource (terminates the process/view). False when it was not stopped. */
  stop: (session: LiveSession) => Promise<StopOutcome>
}

/** Why a stop did not happen: what the user can act on differs (a page in use elsewhere stays in use). */
export type StopOutcome = { stopped: true } | { stopped: false; reason: 'gone' | 'in-use' | 'not-owned' | 'failed' }

export function useLiveSessions(): LiveSessionsApi {
  const { t } = useTranslation()

  const terminalSessionsMap = useTerminalStore(s => s.sessions)
  const aiWriting = useTerminalStore(s => s.aiWriting)
  const openTerminalInCanvas = useTerminalStore(s => s.openInCanvas)
  const killTerminalSession = useTerminalStore(s => s.killSession)

  // The terminal registry is process-global (all spaces), but the tray belongs
  // to the space you're in — an AI terminal kept alive in another space must not
  // leak into this one's tray (it reappears when you return).
  const currentSpaceId = useSpaceStore(s => s.currentSpace?.id)

  // AI browser: every page an AI conversation of this space holds, whichever
  // conversation is on screen, named after its owner so the rows can be told
  // apart. Keyed to the exact viewId — the same identity used to reveal it.
  const browserPages = useAIBrowserStore(s => s.pages)
  const browserViews = useAIBrowserStore(s => s.views)
  const browserOperating = useAIBrowserStore(s => s.operating)
  const apps = useAppsStore(s => s.apps)
  const spaceConversations = useChatStore(s => (currentSpaceId ? s.spaceStates.get(currentSpaceId)?.conversations : undefined))

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
      stoppable: true,
    }))

  const ownerLabel = (conversationId: string): string => {
    const native = parseNativeChatKey(conversationId)
    if (native) return apps.find(a => a.id === native.appId)?.spec.name || t('Digital human')
    return spaceConversations?.find(c => c.id === conversationId)?.title || t('Conversation')
  }
  const browserSessions: LiveSession[] = buildBrowserLiveSessions({
    pages: browserPages,
    views: browserViews,
    spaceId: currentSpaceId,
    operating: browserOperating,
    ownerLabel,
    untitled: t('AI Browser'),
  }).map(s => ({ ...s, stoppable: isElectron() }))

  const sessions = [...browserSessions, ...terminalSessions]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const busy = sessions.some(s => s.busy)

  const open = async (session: LiveSession): Promise<string | null> => {
    // The Canvas lives in the Space view, so a click from Apps or Settings has
    // to land somewhere first. currentSpace is null on pages that never mount
    // SpaceSelector, and after a space is deleted; halo-temp always exists, so
    // it is the fallback rather than a full selectDefaultSpace() lookup.
    const spaceStore = useSpaceStore.getState()
    const target = spaceStore.currentSpace ?? spaceStore.haloSpace
    if (!target) return null
    if (spaceStore.currentSpace?.id !== target.id) spaceStore.setCurrentSpace(target)
    useAppStore.getState().navigate('space')

    // Settle the Canvas's space identity before adding a tab, so teardown from
    // a previous space cannot run over the tab opened next.
    await canvasLifecycle.enterSpace(target.id)
    if (session.kind === 'terminal') {
      return openTerminalInCanvas(session.id, session.title)
    }
    // Attach the exact AI-driven BrowserView (same WebContents).
    return canvasLifecycle.attachAIBrowserView(session.id, session.url || '', session.title)
  }

  const stop = async (session: LiveSession): Promise<StopOutcome> => {
    if (session.kind === 'terminal') {
      await killTerminalSession(session.id)
      return { stopped: true }
    } else {
      // Re-checked at the moment of the click: another conversation may have
      // moved onto the page since the row was drawn.
      // Fast path only: the store can be one event behind, so main checks again
      // and is the one that decides.
      const browser = useAIBrowserStore.getState()
      const page = browser.pages[session.id]
      if (!page) return { stopped: false, reason: 'gone' }
      if (isPageInUseByOthers(browser, session.id)) return { stopped: false, reason: 'in-use' }
      // A stopped page is announced gone, which drops it from the store.
      const result = await api.stopAIBrowserPage(session.id, page.conversationId)
      if (!result.stopped) console.warn(`[LiveSessions] Stop of ${session.id} refused: ${result.reason ?? 'unavailable'}`)
      return result.stopped ? { stopped: true } : { stopped: false, reason: result.reason ?? 'failed' }
    }
  }

  return { sessions, busy, open, stop }
}
