/**
 * NotificationToast — Unified in-app toast notification overlay
 *
 * Renders a stack of floating toasts in the bottom-right corner.
 * Visual style matches the original UpdateNotification component
 * (zinc-800 background, rounded-lg, slide-in animation).
 *
 * Each toast auto-dismisses after its `duration` (0 = sticky).
 * Toasts are ordered oldest-first (newest at the bottom of the stack).
 *
 * Mount once in App.tsx — it reads from useNotificationStore.
 */

import { useEffect, useRef, useCallback } from 'react'
import { X, Bell, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react'
import { useNotificationStore, type ToastItem, type ToastVariant } from '../../stores/notification.store'

// ── Variant config ──────────────────────────────────────

interface VariantStyle {
  icon: React.ReactNode
  bg: string
  text: string
}

const variantStyles: Record<ToastVariant, VariantStyle> = {
  default: {
    icon: <Bell className="w-5 h-5 text-blue-400" />,
    bg: 'bg-blue-500/20',
    text: 'text-blue-400',
  },
  success: {
    icon: <CheckCircle2 className="w-5 h-5 text-emerald-400" />,
    bg: 'bg-emerald-500/20',
    text: 'text-emerald-400',
  },
  warning: {
    icon: <AlertTriangle className="w-5 h-5 text-amber-400" />,
    bg: 'bg-amber-500/20',
    text: 'text-amber-400',
  },
  error: {
    icon: <AlertCircle className="w-5 h-5 text-red-400" />,
    bg: 'bg-red-500/20',
    text: 'text-red-400',
  },
}

// ── Single Toast ────────────────────────────────────────

function Toast({ toast }: { toast: ToastItem }) {
  const dismiss = useNotificationStore((s) => s.dismiss)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDismiss = useCallback(() => {
    dismiss(toast.id)
  }, [dismiss, toast.id])

  // Auto-dismiss. createdAt is in the deps so a stable-id toast replaced via
  // show() restarts its timer — otherwise React reuses the component (key=id)
  // and the effect never re-runs, leaving a replaced toast visible for only
  // the remainder of the original window.
  useEffect(() => {
    if (toast.duration > 0) {
      timerRef.current = setTimeout(handleDismiss, toast.duration)
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [toast.duration, toast.createdAt, handleDismiss])

  const style = variantStyles[toast.variant]

  return (
    <div className="animate-in slide-in-from-bottom-4 fade-in duration-300 pointer-events-auto">
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl p-4 max-w-sm">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className={`flex-shrink-0 w-10 h-10 ${style.bg} rounded-full flex items-center justify-center`}>
            {style.icon}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-zinc-100">{toast.title}</h4>
            {toast.body && (
              <p className="text-xs text-zinc-400 mt-1 line-clamp-3">{toast.body}</p>
            )}

            {/* Actions */}
            {(toast.action || toast.secondaryAction) && (
              <div className="flex items-center gap-2 mt-3">
                {toast.action && (
                  <button
                    onClick={() => { toast.action!.onClick(); handleDismiss() }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 ${
                      toast.variant === 'error'
                        ? 'bg-red-600 hover:bg-red-500'
                        : toast.variant === 'warning'
                          ? 'bg-amber-600 hover:bg-amber-500'
                          : toast.variant === 'success'
                            ? 'bg-emerald-600 hover:bg-emerald-500'
                            : 'bg-blue-600 hover:bg-blue-500'
                    } text-white text-xs font-medium rounded-md transition-colors`}
                  >
                    {toast.action.label}
                  </button>
                )}
                {toast.secondaryAction && (
                  <button
                    onClick={() => { toast.secondaryAction!.onClick(); handleDismiss() }}
                    className="px-3 py-1.5 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
                  >
                    {toast.secondaryAction.label}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Close button */}
          <button
            onClick={handleDismiss}
            className="flex-shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
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
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
