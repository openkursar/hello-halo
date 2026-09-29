/**
 * AI Browser view-lifecycle payloads shared by the main-process event bus, the
 * IPC/WebSocket transport and the renderer store.
 */

/** A conversation's active AI browser view changed (created or selected). */
export interface AIBrowserActiveView {
  /** Conversation driving the view; null for the user's own singleton context. */
  conversationId: string | null
  /** Space the conversation belongs to; null for the user's own singleton context. */
  spaceId: string | null
  viewId: string
  /**
   * Whether the conversation opened this page itself. False when it selected a
   * page someone else opened (the user's own tab, another conversation's):
   * such a page is never listed or stopped as this conversation's.
   */
  owned: boolean
  url: string | null
  title: string | null
}

/** One page an AI conversation holds; `active` marks the page its next tool call acts on. */
export interface AIBrowserLivePage extends AIBrowserActiveView {
  active: boolean
}

/** An AI-driven view was destroyed and can no longer be revealed. */
export interface AIBrowserViewGone {
  viewId: string
}

/**
 * A conversation's browser context ended. Pages it opened and survive (a space
 * chat's tabs stay the user's) are no longer its, and it points at nothing.
 */
export interface AIBrowserConversationReleased {
  conversationId: string
}

/** Outcome of a tray stop; refused when the page is not (or no longer) the named conversation's alone. */
export interface AIBrowserStopResult {
  stopped: boolean
  reason?: 'not-owned' | 'in-use'
}
