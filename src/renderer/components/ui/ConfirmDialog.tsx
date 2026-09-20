/**
 * ConfirmDialog - VSCode-style confirmation dialog
 * Matches the project's AppInstallDialog design
 */

import { createPortal } from 'react-dom'
import { useEffect, useRef } from 'react'

interface ConfirmDialogProps {
  title: string
  message?: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  variant?: 'danger' | 'warning' | 'default'
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  variant = 'danger'
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // Focus management: the prototype is a static demo with no real
  // keyboard-reachable page behind it, so it never needed this — but this
  // app does, so skipping it is a real accessibility regression, not
  // "prototype didn't draw it so we don't need it". Remembers the
  // triggering element, moves focus into the dialog, and restores it on close.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    cancelButtonRef.current?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
      previouslyFocusedRef.current?.focus()
    }
  }, [])

  // Keyboard support: Esc/Enter plus a Tab focus trap so the background page
  // (real, keyboard-reachable content — unlike the prototype) can't be
  // reached while the dialog is open.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      if (e.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (!focusable || focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
        return
      }

      const target = e.target as HTMLElement
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (isInputFocused) return

      if (e.key === 'Enter') {
        onConfirm()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onConfirm, onCancel])

  const confirmButtonClass =
    variant === 'danger'
      ? 'bg-destructive border-destructive hover:bg-destructive/90 text-destructive-foreground'
      : variant === 'warning'
        ? 'bg-amber-600 border-amber-600 hover:bg-amber-500 text-white'
        : 'bg-primary border-primary hover:bg-primary-hover text-primary-foreground'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45"
      onMouseDown={onCancel}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-[420px] mx-4 bg-card border border-border rounded-2xl shadow-pop p-[22px]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Content */}
        <div className="mb-6 space-y-2">
          <p id="confirm-dialog-title" className="text-base font-semibold text-foreground">{title}</p>
          {message && (
            <p className="text-xs text-muted-foreground">{message}</p>
          )}
        </div>

        {/* Actions — unified bordered `.btn` treatment; primary/danger
            variants swap the fill, everything else (height/padding/radius)
            stays the same for both buttons. */}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            onClick={e => { e.stopPropagation(); onCancel() }}
            className="h-9 px-4 rounded-sm border border-border bg-secondary text-[13px] font-medium text-foreground transition-colors hover:bg-surface-hover"
          >
            {cancelLabel}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onConfirm() }}
            className={`h-9 px-4 rounded-sm border text-[13px] font-medium transition-colors ${confirmButtonClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
