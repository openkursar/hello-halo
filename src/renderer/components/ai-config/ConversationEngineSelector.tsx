import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useAppStore } from '../../stores/app.store'
import { saveConversationEngineOverride, useConversationEngineId } from '../../hooks/useConversationEngine'
import { resolveModelSelection, type Conversation, type EngineAvailabilityReport } from '../../types'
import { ENGINE_IDS, isEngineId, type EngineId } from '../../../shared/types/engine'
import { getEngineSourceCompatibility } from '../../../shared/engine-source'

export function ConversationEngineSection({ conversation, spaceId }: { conversation: Conversation; spaceId: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return <div className="mx-2 border-t border-border-faint px-1 py-1.5">
    <button type="button" aria-expanded={expanded} className="flex w-full items-center gap-1 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded(value => !value)}>
      <ChevronRight aria-hidden="true" className={`h-3 w-3 ${expanded ? 'rotate-90' : ''}`} />{t('Advanced')}
    </button>
    {expanded && <ConversationEngineSelector key={conversation.id} conversation={conversation} spaceId={spaceId} />}
  </div>
}

export function ConversationEngineSelector({ conversation, spaceId }: { conversation: Conversation; spaceId: string }) {
  const { t } = useTranslation()
  const sources = useAppStore(state => state.config?.aiSources)
  const navigate = useAppStore(state => state.navigate)
  const actualEngine = useConversationEngineId(conversation.id, spaceId)
  const [report, setReport] = useState<EngineAvailabilityReport | null>(null)
  const [draft, setDraft] = useState<EngineId | ''>(conversation.engineOverride ?? '')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const pending = useRef(false)
  const labels: Record<EngineId, string> = { halo: t('Halo SDK'), anthropic: t('Claude Code'), codex: t('Codex SDK'), dsh: t('DeepSeek dsh') }
  const selectedSource = sources?.version === 2 ? resolveModelSelection(sources, conversation).source : undefined
  const current = actualEngine ?? report?.defaultEngine ?? report?.activeEngine ?? 'halo'
  const chosen = draft || current
  const changed = draft !== (conversation.engineOverride ?? '')
  const unavailable = Boolean(report && !report.engines.find(item => item.engineId === chosen)?.available)
  const accountCompatibility = getEngineSourceCompatibility(chosen, selectedSource)
  const accountMismatch = !accountCompatibility.compatible
  const switching = Boolean(conversation.engineOverride && actualEngine && conversation.engineOverride !== actualEngine)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.getEngineAvailability()
      if (!response.success || !response.data) throw new Error(response.error || 'Engine availability request failed')
      if (mounted.current) setReport(response.data as EngineAvailabilityReport)
    } catch (cause) {
      console.warn('[ConversationEngineSelector] Could not read engine choices', { reason: cause instanceof Error ? cause.message.slice(0, 300) : 'Unknown error' })
      if (mounted.current) setError(t('Engine availability could not be checked. Please try again.'))
    } finally { if (mounted.current) setLoading(false) }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [conversation.id])
  useEffect(() => { setDraft(conversation.engineOverride ?? '') }, [conversation.id, conversation.engineOverride])

  const save = async (engine: EngineId | '') => {
    if (pending.current || loading) return
    pending.current = true
    setSaving(true)
    setError(null)
    const conversationId = conversation.id
    try {
      const refused = await saveConversationEngineOverride(spaceId, conversationId, engine || null)
      if (refused && mounted.current) setError(t(refused))
    } catch (cause) {
      console.warn('[ConversationEngineSelector] Engine preference could not be saved', { conversationId, reason: cause instanceof Error ? cause.message.slice(0, 300) : 'Unknown error' })
      if (mounted.current) setError(t('The engine selection could not be saved. Please try again.'))
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }

  return <div className="space-y-2 px-1 py-2 text-xs">
    <label htmlFor={`conversation-engine-${conversation.id}`} className="font-medium text-foreground">{t('Conversation engine')}</label>
    <p className="text-muted-foreground">{t('Current engine: {{engine}}', { engine: labels[current] })}</p>
    <select
      id={`conversation-engine-${conversation.id}`}
      value={draft}
      disabled={loading || saving || !report}
      onChange={event => setDraft(isEngineId(event.target.value) ? event.target.value : '')}
      className="min-h-11 w-full min-w-0 rounded-md border border-border bg-secondary px-2 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 sm:min-h-8"
    >
      <option value="">{t('Keep current engine')}</option>
      {ENGINE_IDS.map(engine => <option key={engine} value={engine} disabled={!report?.engines.find(item => item.engineId === engine)?.available || !getEngineSourceCompatibility(engine, selectedSource).compatible}>
        {labels[engine]}{report && !report.engines.find(item => item.engineId === engine)?.available ? ` · ${t('Unavailable')}` : !getEngineSourceCompatibility(engine, selectedSource).compatible ? ` · ${t('Incompatible account')}` : ''}
      </option>)}
    </select>
    {loading && <p role="status" className="flex items-center gap-1 text-muted-foreground"><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />{t('Checking…')}</p>}
    {!accountCompatibility.compatible && <p className="text-halo-warning">{accountCompatibility.code === 'delegated-requires-cc'
      ? t('This account requires Claude Code. Choose Claude Code or another model account.')
      : t('Codex supports OpenAI-compatible Chat Completions and Responses accounts. Choose another account or another engine.')}</p>}
    {unavailable && <button type="button" className="text-primary underline" onClick={() => navigate('settings')}>{t('Set up this engine in Settings')}</button>}
    {switching && !changed && <div role="status" className="space-y-1 text-muted-foreground">
      <p>{t('{{engine}} will take over at the next idle turn.', { engine: labels[conversation.engineOverride!] })}</p>
      <button type="button" disabled={saving} className="text-primary underline disabled:opacity-50" onClick={() => void save(actualEngine!)}>{t('Keep using {{engine}}', { engine: labels[actualEngine!] })}</button>
    </div>}
    {changed && <div className="space-y-2 rounded-md border border-border p-2">
      <p className="text-muted-foreground">{draft
        ? t('Running work keeps its current engine. The new engine starts at the next idle turn with your history, goals and task context. Internal execution state may not transfer. Running several engines uses more memory.')
        : t('This conversation will keep its current engine. Changes to the default engine will only apply to new conversations.')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={saving || unavailable || accountMismatch} className="min-h-11 rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground disabled:opacity-50 sm:min-h-8" onClick={() => void save(draft)}>{saving ? t('Saving…') : t('Change engine')}</button>
        <button type="button" disabled={saving} className="min-h-11 rounded-md px-2.5 py-1.5 hover:bg-secondary sm:min-h-8" onClick={() => setDraft(conversation.engineOverride ?? '')}>{t('Cancel')}</button>
      </div>
    </div>}
    {error && <div role="alert" className="space-y-1 text-destructive"><p>{error}</p>{!report && <button type="button" disabled={loading} className="underline" onClick={() => void load()}>{t('Try again')}</button>}</div>}
  </div>
}
