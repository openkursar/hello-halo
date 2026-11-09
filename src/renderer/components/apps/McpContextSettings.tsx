import { useState } from 'react'
import { MCP_CONTEXT_SUMMARY_LIMIT } from '../../../shared/apps/mcp-context'
import type { McpContextPreferences } from '../../../shared/apps/mcp-context'
import { useTranslation } from '../../i18n'
import { CapabilityChangeDialog } from './CapabilityImpact'

interface McpContextSettingsProps {
  appId: string
  value?: McpContextPreferences
  onSave: (patch: Record<string, unknown>) => Promise<boolean>
}

export function McpContextSettings({ appId, value, onSave }: McpContextSettingsProps) {
  const { t } = useTranslation()
  const [loadingDraft, setLoading] = useState(value?.loading ?? 'deferred')
  const [summaryDraft, setSummary] = useState(value?.summary ?? '')
  const [editing, setEditing] = useState({ loading: false, summary: false })
  const [pending, setPending] = useState<Record<string, unknown> | null>(null)
  const loading = editing.loading ? loadingDraft : value?.loading ?? 'deferred'
  const summary = editing.summary ? summaryDraft : value?.summary ?? ''

  const summaryLength = Array.from(summary.trim()).length
  const tooLong = summaryLength > MCP_CONTEXT_SUMMARY_LIMIT
  const patch: Record<string, unknown> = {}
  if (loading !== (value?.loading ?? 'deferred')) patch.loading = loading
  if (summary.trim() !== (value?.summary ?? '')) patch.summary = summary.trim() || null
  const changed = Object.keys(patch).length > 0
  const loadingId = `mcp-loading-${appId}`
  const summaryId = `mcp-summary-${appId}`

  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h3 className="text-sm font-medium">{t('Halo SDK tool loading')}</h3>
      <p className="text-xs text-muted-foreground">
        {t('These settings affect Halo SDK only. Other engines use their own tool-loading behavior. Connection and tool permissions stay separate.')}
      </p>
      <div className="space-y-1.5">
        <label htmlFor={loadingId} className="block text-xs font-medium">{t('Tool loading')}</label>
        <select
          id={loadingId}
          value={loading}
          disabled={pending !== null}
          onChange={event => {
            setLoading(event.target.value as 'eager' | 'deferred')
            setEditing({ ...editing, loading: event.target.value !== (value?.loading ?? 'deferred') })
          }}
          className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground sm:max-w-xs"
        >
          <option value="deferred">{t('On demand')}</option>
          <option value="eager">{t('Always loaded')}</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={summaryId} className="block text-xs font-medium">{t('Capability description')}</label>
        <textarea
          id={summaryId}
          value={summary}
          rows={3}
          maxLength={MCP_CONTEXT_SUMMARY_LIMIT * 2}
          disabled={pending !== null}
          aria-invalid={tooLong}
          aria-describedby={`${summaryId}-help`}
          onChange={event => {
            setSummary(event.target.value)
            setEditing({ ...editing, summary: event.target.value.trim() !== (value?.summary ?? '') })
          }}
          placeholder={t('Describe what this service helps with. Leave blank to use its automatic description.')}
          className="w-full resize-y rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground"
        />
        <p id={`${summaryId}-help`} className={`text-xs ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
          {t('{{count}} / {{limit}} characters', { count: summaryLength, limit: MCP_CONTEXT_SUMMARY_LIMIT })}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('Older conversations keep their original tool context. Start a new conversation to use on-demand loading. In supported conversations, changes apply after current work finishes.')}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={!changed || pending !== null}
          onClick={() => setEditing({ loading: false, summary: false })}
          className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t('Cancel')}
        </button>
        <button
          type="button"
          disabled={!changed || tooLong || pending !== null}
          onClick={() => setPending(patch)}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {t('Save')}
        </button>
      </div>
      {pending && (
        <CapabilityChangeDialog
          appId={appId}
          title={t('Save shared resource changes?')}
          onConfirm={async () => {
            if (!await onSave(pending)) throw new Error(t('MCP context preference save failed'))
            setEditing({ loading: false, summary: false })
          }}
          onClose={() => setPending(null)}
        />
      )}
    </section>
  )
}
