import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../../../../i18n'
import { failureOf } from '../state/git-client'
import { repositorySelectionError, type GitFailure } from '../state/git-errors'

export function RepositoryPathDialog({ disabled, opener, onOpen, onClose }: {
  disabled: boolean
  opener: RefObject<HTMLButtonElement>
  onOpen: (root: string) => Promise<GitFailure | null>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)
  const alive = useRef(true)
  const submitting = useRef(false)
  const [path, setPath] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    alive.current = true
    inputRef.current?.focus()
    return () => {
      alive.current = false
      opener.current?.focus()
    }
  }, [opener])

  const submit = async () => {
    if (disabled || submitting.current) return
    const root = path.trim()
    if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root) && !root.startsWith('\\\\')) {
      setError(t('Enter an absolute directory path on the computer hosting Halo.'))
      return
    }
    submitting.current = true
    setPending(true)
    setError(null)
    try {
      const failure = await onOpen(root)
      if (!alive.current) return
      if (failure) setError(repositorySelectionError(failure, t))
      else onClose()
    } catch (cause) {
      console.warn('[ChangesView] Could not open host repository:', failureOf(cause))
      if (alive.current) setError(t('Could not open the repository. Try again.'))
    } finally {
      submitting.current = false
      if (alive.current) setPending(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[var(--layer-global-modal)] flex items-center justify-center bg-background/80 p-4" onMouseDown={() => { if (!pending) onClose() }}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        aria-busy={pending}
        className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-5 text-foreground shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void submit() }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (!pending) onClose()
          }
          if (event.key !== 'Tab') return
          const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])]
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <h2 id={`${id}-title`} className="text-base font-semibold">{t('Open repository')}</h2>
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">{t('Enter the absolute path of a Git repository within this space on the computer hosting Halo, not on this device. Choose the repository folder itself; parent folders are not searched.')}</p>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-path`} className="text-sm">{t('Repository directory on host')}</label>
          <input
            ref={inputRef}
            id={`${id}-path`}
            value={path}
            readOnly={pending}
            onChange={(event) => setPath(event.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : `${id}-hint`}
            autoComplete="off"
            spellCheck={false}
            className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          />
        </div>
        {error && <p id={`${id}-error`} role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={pending} onClick={onClose} className="h-11 rounded-md border border-border px-4 text-sm hover:bg-secondary disabled:opacity-50">{t('Cancel')}</button>
          <button type="submit" disabled={disabled || pending || !path.trim()} className="h-11 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-primary-hover disabled:opacity-50">{pending ? t('Opening…') : t('Open repository')}</button>
        </div>
      </form>
    </div>,
    document.body
  )
}
