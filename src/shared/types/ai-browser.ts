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

/** A website opened a child of an AI-owned page without selecting it for the AI. */
export interface AIBrowserPageOpened extends AIBrowserActiveView {
  openerViewId: string
}

/** One page an AI conversation holds; `active` marks the page its next tool call acts on. */
export interface AIBrowserLivePage extends AIBrowserActiveView {
  active: boolean
  /** The active page while the conversation's AI is operating its browser. */
  operating?: boolean
  /** Still alive after its conversation released it; no longer an AI tab. */
  released?: boolean
}

/**
 * Whether a conversation's AI is operating its browser, from its first tool
 * call until a while after the last (shared/ai-operating.ts).
 */
export interface AIBrowserOperating {
  conversationId: string
  operating: boolean
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

/** Outcome of ending an AI page; refused when the page is not (or no longer) the named conversation's alone. */
export interface AIBrowserStopResult {
  stopped: boolean
  reason?: 'not-owned' | 'in-use'
}

/** One input the user is asked to type into themselves, named by the page's own label for it. */
export interface AIBrowserSecretField {
  /** Snapshot uid of the input the text goes into. */
  uid: string
  label: string
}

/**
 * A page is waiting for text the model must not hold — a PIN, a one-time
 * token. The payload carries the fields to fill and the origin that will
 * receive them, never any value.
 */
export interface AIBrowserCredentialRequest {
  requestId: string
  /** Conversation whose page is asking; null for the user's own singleton context. */
  conversationId: string | null
  spaceId: string | null
  viewId: string
  /** Origin of the page the text will be typed into, so the user can check it before typing. */
  origin: string
  title: string | null
  fields: AIBrowserSecretField[]
  /**
   * What the assistant says the page is asking for. Written by the model, so a
   * client must present it as the assistant's words, never as Halo's.
   */
  purpose: string
  /** Epoch ms after which the request is abandoned. */
  expiresAt: number
}

/** A credential request stopped waiting; every prompt open for it must close. */
export interface AIBrowserCredentialResolved {
  requestId: string
  outcome: 'provided' | 'declined' | 'expired'
}
