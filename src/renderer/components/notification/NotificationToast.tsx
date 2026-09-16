/**
 * NotificationToast — Unified in-app toast notification overlay
 *
 * Renders a stack of floating toasts in the bottom-right corner.
 *
 * Each toast auto-dismisses after its `duration` (0 = sticky). A toast marked
 * `dismissible: false` drops the close button and outlives its own action.
 * Toasts are ordered oldest-first (newest at the bottom of the stack).
 *
 * Mount once in App.tsx — it reads from useNotificationStore.
 */

import { useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { X, Bell, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react'
import { useNotificationStore, type ToastItem, type ToastVariant } from '../../stores/notification.store'

// This component is mounted at the app root, so a static import would pull the
// markdown parser into the entry chunk for a surface most sessions never show
// rich copy in. The fallback renders the same text unparsed, which stays
// readable for the moment the chunk takes to arrive.
const RichText = lazy(() => import('../ui/RichText').then(m => ({ default: m.RichText })))

// ── Variant config ──────────────────────────────────────

// The variant tints the icon and its halo only. The action button stays
// `primary` across all four: a tinted button would have to carry white text at
// `text-xs` on amber or green, which is unreadable, and the variant is already
// carried by the glyph, the halo and the title.
interface VariantStyle {
  icon: React.ReactNode
  /** Icon halo behind the glyph */
  bg: string
}

const variantStyles: Record<ToastVariant, VariantStyle> = {
  default: {
    icon: <Bell className="w-5 h-5 text-primary" />,
    bg: 'bg-primary/10',
  },
  success: {
    icon: <CheckCircle2 className="w-5 h-5 text-halo-success" />,
    bg: 'bg-halo-success/10',
  },
  warning: {
    icon: <AlertTriangle className="w-5 h-5 text-halo-warning" />,
    bg: 'bg-halo-warning/10',
  },
  error: {
    icon: <AlertCircle className="w-5 h-5 text-halo-error" />,
    bg: 'bg-halo-error/10',
  },
}

// ── Single Toast ────────────────────────────────────────

function Toast({ toast }: { toast: ToastItem }) {
  const dismiss = useNotificationStore((s) => s.dismiss)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissible = toast.dismissible !== false

  const handleDismiss = useCallback(() => {
    dismiss(toast.id)
  }, [dismiss, toast.id])

  // Auto-dismiss
  useEffect(() => {
    if (dismissible && toast.duration > 0) {
      timerRef.current = setTimeout(handleDismiss, toast.duration)
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [dismissible, toast.duration, handleDismiss])

  const style = variantStyles[toast.variant]
  // Server-authored copy is structured and usually longer, so it earns the
  // wider card. Plain one-line toasts keep the original width.
  const isRich = toast.bodyFormat === 'markdown'

  return (
    <div className="animate-in slide-in-from-bottom-4 fade-in duration-300 pointer-events-auto">
      <div className={`bg-popover text-popover-foreground border border-border rounded-lg shadow-xl p-4 w-full sm:w-auto ${isRich ? 'sm:max-w-md' : 'sm:max-w-sm'}`}>
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className={`flex-shrink-0 w-10 h-10 ${style.bg} rounded-full flex items-center justify-center`}>
            {style.icon}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium">{toast.title}</h4>
            {toast.body && (
              // overflow-x-hidden is load-bearing: `overflow-y: auto` promotes
              // the cross axis from `visible` to `auto` per spec, so without it
              // an unbreakable token (a tool name, a URL) would add a
              // horizontal scrollbar and its corner square to a card this small.
              <div className="mt-1 max-h-32 overflow-y-auto overflow-x-hidden scrollbar-thin text-xs text-muted-foreground">
                {isRich
                  ? (
                    <Suspense fallback={<p className="whitespace-pre-line break-words">{toast.body}</p>}>
                      <RichText content={toast.body} />
                    </Suspense>
                  )
                  : <p className="whitespace-pre-line break-words">{toast.body}</p>}
              </div>
            )}

            {/* Actions */}
            {(toast.action || toast.secondaryAction) && (
              <div className="flex items-center gap-2 mt-3">
                {toast.action && (
                  <button
                    onClick={() => { toast.action!.onClick(); if (dismissible) handleDismiss() }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-medium rounded-md transition-colors"
                  >
                    {toast.action.label}
                  </button>
                )}
                {toast.secondaryAction && (
                  <button
                    onClick={() => { toast.secondaryAction!.onClick(); handleDismiss() }}
                    className="px-3 py-1.5 text-muted-foreground hover:text-foreground text-xs transition-colors"
                  >
                    {toast.secondaryAction.label}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Close button */}
          {dismissible && (
            <button
              onClick={handleDismiss}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Container ───────────────────────────────────────────

export function NotificationToast() {
  const toasts = useNotificationStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 z-50 flex flex-col items-stretch sm:items-end gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
