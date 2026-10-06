/**
 * The activity note an author's upgrade leaves when fields of the digital
 * human differ from the new version and kept the user's version: which fields,
 * the author's version of each on request, and switching any of them to it.
 *
 * The wording never says the user changed them: after an upgrade that had no
 * earlier author's version to compare with, that is not known.
 */

import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { SpecUpgradeNote } from '../../../shared/apps/app-types'
import type { AppSpec, SubscriptionDef } from '../../../shared/apps/spec-types'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { specFieldLabel } from './spec-field-label'
import { formatCronHumanReadable, formatFrequency } from './schedule-utils'

interface UpgradeNoteProps {
  appId: string
  entryId: string
  note: SpecUpgradeNote
}

function fieldOf(spec: AppSpec | undefined, field: string): unknown {
  return spec ? (spec as unknown as Record<string, unknown>)[field] : undefined
}

function describeTrigger(sub: SubscriptionDef, t: TFunction, language: string): string {
  if (sub.source.type === 'schedule') {
    const { cron, every } = sub.source.config
    if (cron) return formatCronHumanReadable(cron, language)
    if (every) return formatFrequency(every, t)
  }
  return t('Trigger: {{type}}', { type: sub.source.type })
}

function FieldValue({ field, value }: { field: string; value: unknown }) {
  const { t, i18n } = useTranslation()
  if (value === undefined || value === null) {
    return <p className="text-xs text-muted-foreground">{t('Not set')}</p>
  }
  if (field === 'subscriptions' && Array.isArray(value)) {
    if (value.length === 0) return <p className="text-xs text-muted-foreground">{t('No run times')}</p>
    return (
      <ul className="space-y-1 text-xs text-foreground">
        {(value as SubscriptionDef[]).map((sub, index) => (
          <li key={index} className="break-words">{describeTrigger(sub, t, i18n.language)}</li>
        ))}
      </ul>
    )
  }
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-2 text-xs text-foreground">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  )
}

export function UpgradeNote({ appId, entryId, note }: UpgradeNoteProps) {
  const { t } = useTranslation()
  const current = useAppsStore(state => state.apps.find(app => app.id === appId))
  const [open, setOpen] = useState(false)
  const [author, setAuthor] = useState<AppSpec | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const adopted = new Set(note.adopted ?? [])
  const remaining = note.kept.filter(field => !adopted.has(field))

  const toggleAuthorVersion = async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (author !== undefined) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.appGetAuthorSpec(appId)
      if (!res.success) throw new Error(res.error ?? 'Request rejected')
      setAuthor(res.data ?? null)
    } catch (err) {
      console.warn('[UpgradeNote] Author version unavailable', { appId, error: err })
      setError(t('The author’s version could not be loaded. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  const switchToAuthorVersion = async (fields: string[]) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.appAdoptAuthorVersion(appId, entryId, fields)
      if (!res.success || !res.data) throw new Error(res.error ?? 'Request rejected')
      useAppsStore.getState().handleNewActivityEntry(appId, res.data)
      await useAppsStore.getState().refreshApp(appId)
    } catch (err) {
      console.warn('[UpgradeNote] Switching to the author’s version failed', { appId, fields, error: err })
      // The reason is untranslated main-process text, so it goes to the log only.
      setError(t('Could not switch to the author’s version. An item that depends on another one can only switch together with it.'))
    } finally {
      setBusy(false)
    }
  }

  const actionClass = 'inline-flex min-h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <div className="space-y-2">
      <p className="text-sm text-foreground">
        {t('Upgraded from v{{from}} to v{{to}}.', { from: note.fromVersion, to: note.toVersion })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('These differ from the author’s new version, so your current version was kept:')}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {note.kept.map(field => (
          <span key={field} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground">
            {adopted.has(field) && <Check className="h-3 w-3 text-halo-success" aria-label={t('Using the author’s version')} />}
            {specFieldLabel(field, t)}
          </span>
        ))}
      </div>
      {!note.editsKnown && (
        <p className="text-xs text-muted-foreground">
          {t('Halo cannot tell which of them you changed.')}
          {note.kept.includes('subscriptions') && !adopted.has('subscriptions') && ` ${t('Run times the author added were not added; use the author’s version to get them.')}`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={toggleAuthorVersion}
          className={`${actionClass} border border-border text-muted-foreground hover:text-foreground`}
        >
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {open ? t('Hide the author’s version') : t('View the author’s version')}
        </button>
        {remaining.length > 0 && (
          <button
            onClick={() => void switchToAuthorVersion(remaining)}
            disabled={busy}
            className={`${actionClass} bg-primary/10 text-primary hover:bg-primary/20`}
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {remaining.length > 1 ? t('Use the author’s version for all') : t('Use the author’s version')}
          </button>
        )}
      </div>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      {open && (
        loading ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('Loading the author’s version…')}
          </p>
        ) : author === null ? (
          <p className="text-xs text-muted-foreground">{t('No author’s version is recorded for this digital human.')}</p>
        ) : author ? (
          <div className="space-y-2">
            {note.kept.map(field => (
              <div key={field} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{specFieldLabel(field, t)}</span>
                  {adopted.has(field) ? (
                    <span className="inline-flex items-center gap-1 text-xs text-halo-success">
                      <Check className="h-3 w-3" />
                      {t('Using the author’s version')}
                    </span>
                  ) : (
                    <button
                      onClick={() => void switchToAuthorVersion([field])}
                      disabled={busy}
                      className={`${actionClass} bg-primary/10 text-primary hover:bg-primary/20`}
                    >
                      {t('Use the author’s version')}
                    </button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="mb-1 text-[11px] text-muted-foreground">{t('Your current version')}</p>
                    <FieldValue field={field} value={fieldOf(current?.spec, field)} />
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1 text-[11px] text-muted-foreground">{t('Author’s version (v{{version}})', { version: author.version })}</p>
                    <FieldValue field={field} value={fieldOf(author, field)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null
      )}
    </div>
  )
}
