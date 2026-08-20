/**
 * SystemPromptEditor
 *
 * System prompt editing widget with two UX layers:
 *
 *   1. Inline editor — auto-grows up to max-h-[400px], then scrolls.
 *      An expand icon sits in the bottom-right corner.
 *
 *   2. Dialog editor — follows the project's standard Dialog pattern
 *      (backdrop + centered card + footer buttons), consistent with
 *      AppInstallDialog and ManualAddDialog. Cancel reverts to the value
 *      captured on open; Done keeps the current value.
 *
 * The label is rendered by the parent — this component is a drop-in
 * replacement for a plain <textarea>.
 */

import { useRef, useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAutoResize } from '../../hooks/useAutoResize'
import { cn } from '../../lib/utils'

interface SystemPromptEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Monospace font — for spec/code-style prompts */
  fontMono?: boolean
  /** Show * in the dialog title */
  required?: boolean
  /** Extra className on the inline textarea */
  className?: string
  /** Called after the dialog closes via Done (not Cancel). Use to trigger a form save. */
  onDone?: () => void
  /**
   * Dialog heading. Name the task, not the field — the label at the entry
   * already carries the field name. Defaults to "System Prompt".
   */
  title?: string
  /**
   * Fires when the inline textarea loses focus. Forms that save on blur need
   * this: the expand dialog closes without producing one, so onDone alone
   * would leave everything typed inline unsaved.
   */
  onBlur?: () => void
}

export function SystemPromptEditor({
  value,
  onChange,
  placeholder,
  fontMono = false,
  required = false,
  className = '',
  onDone,
  title,
  onBlur,
}: SystemPromptEditorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const inlineRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLTextAreaElement>(null)
  // Value snapshot taken when dialog opens — restored on Cancel
  const originalRef = useRef('')

  useAutoResize(inlineRef, value)

  // ── Open / close ────────────────────────────────────────────────────────

  const openDialog = useCallback(() => {
    originalRef.current = value
    setOpen(true)
  }, [value])

  const done = useCallback(() => {
    setOpen(false)
    onDone?.()
  }, [onDone])

  const cancel = useCallback(() => {
    onChange(originalRef.current)
    setOpen(false)
  }, [onChange])

  // Focus + move cursor to end once the portal mounts
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => {
      const el = dialogRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
    return () => clearTimeout(id)
  }, [open])

  // ESC → cancel
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, cancel])

  // ── Helpers ──────────────────────────────────────────────────────────────

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value),
    [onChange]
  )

  /**
   * Opening the dialog blurs the inline textarea, and a caller that saves on
   * blur would then save mid-edit. The round trip comes back while the user is
   * still typing in the dialog, and a parent that re-seeds its state from the
   * saved value wipes whatever was typed after the save left.
   *
   * Expanding is not a commit point — Done is. Set on mousedown, which runs
   * before blur, so this does not depend on the button taking focus.
   */
  const expandingRef = useRef(false)

  const handleInlineBlur = useCallback(() => {
    if (expandingRef.current) {
      expandingRef.current = false
      return
    }
    onBlur?.()
  }, [onBlur])

  const monoClass = fontMono ? ' font-mono' : ''

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Inline auto-grow textarea ──────────────────────────────────── */}
      <div className="relative group">
        <textarea
          ref={inlineRef}
          value={value}
          onChange={handleChange}
          onBlur={handleInlineBlur}
          placeholder={placeholder}
          spellCheck={false}
          style={{ minHeight: '144px' }}
          className={cn(
            'w-full px-3 py-2 text-sm',
            'bg-secondary border border-border rounded-lg',
            'focus:outline-none focus:ring-1 focus:ring-primary',
            'text-foreground placeholder:text-muted-foreground/50',
            'resize-none overflow-y-auto max-h-[400px]',
            monoClass,
            className,
          )}
        />

        {/* Expand button — hover-reveal on desktop, always on mobile */}
        <button
          type="button"
          onMouseDown={() => { expandingRef.current = true }}
          onClick={openDialog}
          title={t('Expand editor')}
          aria-label={t('Expand editor')}
          className="absolute bottom-2 right-2 p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-background/80 transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Dialog editor — same pattern as AppInstallDialog ──────────── */}
      {open && createPortal(
        // Backdrop — click to cancel
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="system-prompt-editor-title"
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
          onMouseDown={cancel}
        >
          {/* Card */}
          <div
            className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-3xl flex flex-col"
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <h2 id="system-prompt-editor-title" className="text-lg font-semibold text-foreground">
                {title ?? t('System Prompt')}
                {required && <span className="text-red-400 ml-1">*</span>}
              </h2>
              <button
                type="button"
                onClick={cancel}
                className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Textarea */}
            <textarea
              ref={dialogRef}
              value={value}
              onChange={handleChange}
              spellCheck={false}
              placeholder={placeholder}
              className={[
                'w-full h-[60vh] px-6 py-4',
                'text-sm bg-transparent',
                'focus:outline-none',
                'text-foreground placeholder:text-muted-foreground/50',
                'resize-none',
                monoClass,
              ].filter(Boolean).join(' ')}
            />

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border flex-shrink-0">
              <span className="text-xs text-muted-foreground tabular-nums">
                {value.length > 0 && t('{{count}} chars', { count: value.length })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={cancel}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg hover:bg-secondary transition-colors"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="button"
                  onClick={done}
                  className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                >
                  {t('Done')}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
