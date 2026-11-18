/**
 * Prompt for text the assistant must not hold — a PIN, a one-time code, an
 * authenticator token the page is asking for.
 *
 * What is typed here goes to the main process and straight into the page's own
 * input. It never enters the conversation, so it cannot be read back out of the
 * transcript, out of a log, or by the model on a later turn.
 *
 * Two things the user has to be able to check before typing, and so are shown
 * verbatim rather than paraphrased: the origin that will receive the text, and
 * which of the page's own fields it goes into. `purpose` is the assistant's
 * wording and is labelled as such — it explains the ask, it does not vouch for
 * the site.
 */

import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useAIBrowserStore, useOldestCredentialRequest } from '../../stores/ai-browser.store'
import type { AIBrowserCredentialRequest } from '../../../shared/types/ai-browser'

export function BrowserCredentialPrompt() {
  const request = useOldestCredentialRequest()
  if (!request) return null
  // Keyed so moving to the next request starts with empty inputs instead of
  // carrying the previous one's keystrokes into a different page.
  return <CredentialDialog key={request.requestId} request={request} />
}

function CredentialDialog({ request }: { request: AIBrowserCredentialRequest }) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const removeCredentialRequest = useAIBrowserStore(state => state.removeCredentialRequest)

  useEffect(() => {
    firstInputRef.current?.focus()
  }, [])

  const complete = request.fields.every(field => (values[field.uid] ?? '').length > 0)

  const submit = async () => {
    if (!complete || busy) return
    setBusy(true)
    setError(null)
    const result = await api.submitAIBrowserCredential(request.requestId, values)
    // Drop the local copy either way: on success it is in the page, and on
    // failure it must not sit in renderer state waiting for a retry.
    setValues({})
    setBusy(false)
    if (result.success) removeCredentialRequest(request.requestId)
    else setError(result.error ?? t('Could not send this to the page'))
  }

  const decline = async () => {
    if (busy) return
    setBusy(true)
    setValues({})
    await api.declineAIBrowserCredential(request.requestId)
    removeCredentialRequest(request.requestId)
  }

  return createPortal(
    <div className="fixed inset-0 z-[var(--layer-global-modal)] flex items-center justify-center bg-black/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-credential-title"
        className="relative w-full max-w-[440px] bg-card border border-border rounded-2xl shadow-pop p-[22px]"
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); void decline() } }}
      >
        <p id="browser-credential-title" className="text-base font-semibold text-foreground">
          {t('The page is asking you to type something')}
        </p>

        <p className="mt-2 text-xs text-muted-foreground">
          {t('What you type goes straight into the page. It is not added to the conversation and the assistant never sees it.')}
        </p>

        <div className="mt-4 rounded-sm border border-border bg-secondary px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('Will be sent to')}</p>
          <p className="mt-0.5 break-all text-[13px] font-medium text-foreground">{request.origin}</p>
          {request.title && (
            <p className="mt-0.5 break-all text-xs text-muted-foreground">{request.title}</p>
          )}
        </div>

        <p className="mt-3 text-[13px] text-foreground">
          <span className="text-muted-foreground">{t('The assistant says:')}</span>{' '}
          {request.purpose}
        </p>

        <div className="mt-4 space-y-3">
          {request.fields.map((field, index) => (
            <label key={field.uid} className="block">
              <span className="block text-xs text-muted-foreground">{field.label}</span>
              <input
                ref={index === 0 ? firstInputRef : undefined}
                type="password"
                autoComplete="one-time-code"
                spellCheck={false}
                value={values[field.uid] ?? ''}
                onChange={e => setValues(prev => ({ ...prev, [field.uid]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') void submit() }}
                disabled={busy}
                className="mt-1 h-9 w-full rounded-sm border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-60"
              />
            </label>
          ))}
        </div>

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            onClick={() => void decline()}
            disabled={busy}
            className="h-9 px-4 rounded-sm border border-border bg-secondary text-[13px] font-medium text-foreground transition-colors hover:bg-surface-hover disabled:opacity-60"
          >
            {t('Not now')}
          </button>
          <button
            onClick={() => void submit()}
            disabled={!complete || busy}
            className="h-9 px-4 rounded-sm border border-primary bg-primary text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {t('Send to page')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
