/**
 * In-app toast notification contract.
 *
 * Shared because the same shape is produced by the main process
 * (`services/notification.service.ts`) and consumed by the renderer store —
 * a re-declaration on either side would silently drop fields in transit.
 *
 * Everything here must stay JSON-serializable: toasts reach remote and mobile
 * clients over WebSocket, not just the Electron renderer.
 */

export type ToastVariant = 'default' | 'success' | 'warning' | 'error'

/**
 * How `body` should be rendered.
 *
 * - 'text'     — plain text, whitespace preserved (default; every legacy caller)
 * - 'markdown' — restricted markdown: lists, emphasis, inline links. Raw HTML is
 *                never rendered and link protocols are filtered, because this
 *                content can originate from a remote server (release notes,
 *                announcements). See `components/ui/RichText.tsx`.
 */
export type ToastBodyFormat = 'text' | 'markdown'

/**
 * Link action for toasts that cross a process boundary.
 *
 * Renderer-local toasts use a callback instead; a callback cannot survive IPC,
 * so main-originated actions declare a URL and the renderer binds the handler.
 */
export interface ToastLinkAction {
  label: string
  url: string
}

/** Wire shape of the `notification:toast` event (main → renderer). */
export interface ToastPayload {
  /** Stable id — repeat sends with the same id replace rather than stack. */
  id?: string
  title: string
  body?: string
  bodyFormat?: ToastBodyFormat
  variant?: ToastVariant
  /** Auto-dismiss in ms. 0 = sticky (manual dismiss only). */
  duration?: number
  /** Deep-links the toast to an installed App's activity thread. */
  appId?: string
  action?: ToastLinkAction
}
