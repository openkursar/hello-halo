import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Cpu, Loader2 } from 'lucide-react'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { ENGINE_IDS, isEngineId, type EngineId } from '../../../shared/types/engine'
import { getEngineSourceCompatibility } from '../../../shared/engine-source'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { resolveModelSelection, type EngineAvailabilityReport, type EngineCapabilities } from '../../types'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'

interface Props {
  app: InstalledApp
  onChange: (engineId: EngineId | undefined) => Promise<boolean>
}

export function AppEngineSelector({ app, onChange }: Props) {
  const { t } = useTranslation()
  const aiSources = useAppStore(state => state.config?.aiSources)
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const [availability, setAvailability] = useState<EngineAvailabilityReport | null>(null)
  const [capabilities, setCapabilities] = useState<Partial<Record<EngineId, EngineCapabilities>>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const pending = useRef(false)

  const labels: Record<EngineId, string> = {
    halo: t('Halo SDK'),
    anthropic: t('Claude Code'),
    codex: t('Codex SDK'),
    dsh: t('DeepSeek dsh'),
  }

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [report, ...descriptors] = await Promise.all([
        api.getEngineAvailability(),
        ...ENGINE_IDS.map(engineId => api.getEngineCapabilities(engineId)),
      ])
      if (!report.success || !report.data || descriptors.some(result => !result.success || !result.data)) throw new Error('Engine settings unavailable')
      if (!mounted.current) return
      setAvailability(report.data as EngineAvailabilityReport)
      setCapabilities(Object.fromEntries(descriptors.map((result, index) => [ENGINE_IDS[index], result.data])) as Partial<Record<EngineId, EngineCapabilities>>)
    } catch (cause) {
      console.warn('[AppEngineSelector] Engine choices could not be loaded', { name: cause instanceof Error ? cause.name : 'UnknownError' })
      if (mounted.current) setError(t('Engine availability could not be checked. Please try again.'))
    } finally { if (mounted.current) setLoading(false) }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [])

  const source = aiSources?.version === 2 ? resolveModelSelection(aiSources, app.userOverrides).source : undefined
  const defaultEngine = availability?.defaultEngine ?? availability?.activeEngine ?? 'halo'
  const chosen = app.userOverrides.engineId ?? defaultEngine
  const descriptor = capabilities[chosen]
  const unavailable = availability && !availability.engines.find(item => item.engineId === chosen)?.available
  const compatibility = getEngineSourceCompatibility(chosen, source)
  const restrictedTeamSupport = descriptor && (!descriptor.features.hooks || !descriptor.features.permissionRules)

  const change = async (value: string) => {
    if (pending.current || loading) return
    const engineId = isEngineId(value) ? value : undefined
    if (engineId === app.userOverrides.engineId) return
    const effective = engineId ?? defaultEngine
    if (!availability?.engines.find(item => item.engineId === effective)?.available) return
    if (!getEngineSourceCompatibility(effective, source).compatible) return
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      const confirmed = await showConfirm({
        title: t('Change this digital human’s engine?'),
        message: engineId
          ? t('Running work will finish with its current engine. The new engine takes over at the next idle turn using a handoff of the conversation history; internal execution state does not transfer. Running several engines in parallel uses more memory. Halo SDK is recommended for lower resource use.')
          : t('New conversations and tasks will use the default engine. Existing conversations keep their current engine, and running work will not be interrupted.'),
        confirmLabel: t('Change engine'),
        cancelLabel: t('Cancel'),
        variant: 'warning',
      })
      if (confirmed && mounted.current && !await onChange(engineId)) {
        setError(t('The engine selection could not be saved. Please try again.'))
      }
    } catch (cause) {
      console.warn('[AppEngineSelector] Engine preference could not be saved', { appId: app.id, name: cause instanceof Error ? cause.name : 'UnknownError' })
      if (mounted.current) setError(cause instanceof Error ? t(cause.message) : t('The engine selection could not be saved. Please try again.'))
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }

  return <div className="space-y-3">
    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Cpu aria-hidden="true" className="h-3.5 w-3.5" />{t('AI Agent Engine')}</h3>
    <p className="text-xs text-muted-foreground">{t('Choose an engine for this digital human’s chats, team work and scheduled runs. Halo SDK uses fewer resources when several digital humans work at once.')}</p>
    <select
      aria-label={t('Digital human engine')}
      disabled={loading || saving || !availability}
      value={app.userOverrides.engineId ?? ''}
      onChange={event => void change(event.target.value)}
      className="w-full min-w-0 rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
    >
      <option value="" disabled={!getEngineSourceCompatibility(defaultEngine, source).compatible}>{t('Default for new sessions')} · {labels[defaultEngine]}{!getEngineSourceCompatibility(defaultEngine, source).compatible ? ` · ${t('Incompatible account')}` : ''}</option>
      {ENGINE_IDS.map(engineId => <option key={engineId} value={engineId} disabled={!availability?.engines.find(item => item.engineId === engineId)?.available || !getEngineSourceCompatibility(engineId, source).compatible}>
        {labels[engineId]}{availability && !availability.engines.find(item => item.engineId === engineId)?.available ? ` · ${t('Unavailable')}` : !getEngineSourceCompatibility(engineId, source).compatible ? ` · ${t('Incompatible account')}` : ''}
      </option>)}
    </select>
    {loading && <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />{t('Checking…')}</p>}
    {saving && <p role="status" className="text-xs text-muted-foreground">{t('Saving…')}</p>}
    {unavailable && <p role="alert" className="text-xs text-destructive">{t('This engine is unavailable. Set it up in Settings or choose another engine. Your selection is kept; Halo will not silently use another engine.')}</p>}
    {!compatibility.compatible && <p role="alert" className="text-xs text-destructive">{t(compatibility.message)}</p>}
    {restrictedTeamSupport && <p className="flex items-start gap-1.5 text-xs text-halo-warning"><AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{t('This engine cannot enforce all team and guest permissions. Requests requiring those protections will be refused; permissions will not be relaxed.')}</span></p>}
    {!app.userOverrides.engineId && <p className="text-xs text-muted-foreground">{t('Existing conversations keep their engine. The default applies when a new conversation or task starts.')}</p>}
    {error && <div role="alert" className="space-y-1 text-xs text-destructive"><p>{error}</p>{!availability && <button type="button" className="rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" disabled={loading} onClick={() => void load()}>{t('Try again')}</button>}</div>}
    {DialogComponent}
  </div>
}
