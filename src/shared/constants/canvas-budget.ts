/**
 * Resource ceilings for the Content Canvas. Every open tab can pin memory
 * (file text up to 10 MB, document bytes up to 25 MB) and every live browser
 * tab is a Chromium renderer process, so the canvas keeps what is hidden within
 * these bounds, least recently used first. Unsaved edits are never dropped.
 */

/** Open tabs beyond this close, least recently used first (never a dirty tab). */
export const MAX_OPEN_TABS = 30

/** Live browser views (processes) beyond this are released while hidden; they reload on activation. */
export const MAX_LIVE_BROWSER_VIEWS = 6

/** Text and bytes held by hidden file tabs beyond this are dropped; they re-read on activation. */
export const HIDDEN_CONTENT_BUDGET_BYTES = 64 * 1024 * 1024
