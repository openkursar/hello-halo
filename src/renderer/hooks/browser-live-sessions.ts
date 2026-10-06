/**
 * The tray rows for AI browser pages: every live page an AI conversation opened
 * itself in the given space, one row each — never a page someone else opened or
 * another conversation is on (stopping it would close it under them) — named after the conversation or digital
 * human that owns it. Pure, so the space filter and labelling can be tested
 * without the stores.
 */

import { isPageInUseByOthers, type AIBrowserPage, type AIBrowserView } from '../stores/ai-browser.store'
import { parseNativeChatKey, parseRunSenderKey } from '../../shared/apps/im-keys'

export interface BrowserLiveSession {
  id: string
  kind: 'browser'
  title: string
  url: string | null
  busy: boolean
  lastActivityAt: number
}

export interface BrowserLiveSessionInput {
  pages: Record<string, AIBrowserPage>
  /** Active page per conversation, to leave out pages another conversation is on. */
  views: Record<string, AIBrowserView>
  /** The space whose tray this is; pages of other spaces never appear. */
  spaceId: string | undefined
  operating: Record<string, boolean>
  /** Who holds the page — a digital human's or a conversation's name. */
  ownerLabel: (conversationId: string) => string
  /** Used when the page has neither a title nor a usable URL yet. */
  untitled: string
}

export function buildBrowserLiveSessions(input: BrowserLiveSessionInput): BrowserLiveSession[] {
  if (!input.spaceId) return []
  return Object.values(input.pages)
    .filter(page => page.spaceId === input.spaceId && !isPageInUseByOthers(input, page.viewId))
    .map(page => ({
      id: page.viewId,
      kind: 'browser' as const,
      title: `${input.ownerLabel(page.conversationId)} · ${page.title || hostnameOf(page.url) || input.untitled}`,
      url: page.url,
      busy: !!input.operating[page.conversationId],
      lastActivityAt: page.lastActivityAt,
    }))
}

/** The digital human whose chat, or whose run started from the desktop, holds a page; null for a space conversation. */
export function pageOwnerAppId(conversationId: string): string | null {
  return parseNativeChatKey(conversationId)?.appId ?? parseRunSenderKey(conversationId)?.appId ?? null
}

/** Best-effort hostname for a display label; null when the URL is unusable. */
export function hostnameOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
