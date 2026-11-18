import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AISourcesConfig } from '../../../shared/types/ai-sources'
import type { SubagentModelProfile, SubagentModelSettings } from '../../../shared/types/subagent-models'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { inlineFormPrimary } from '../ui/inline-form-actions'
import { ProfileEditor } from './ProfileEditor'
import { profileName, profilePurpose, targetLabel } from './model-presentation'

const PAGE_SIZE = 10

export default function SubagentModelsManager({ config, onClose, onBusyChange, onDraftChange }: {
  config: AISourcesConfig
  onClose: () => void
  onBusyChange: (busy: boolean) => void
  onDraftChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<SubagentModelSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changeNotice, setChangeNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const editingRef = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [page, setPage] = useState(0)
  const root = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(false)
  const mounted = useRef(true)
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const load = async () => {
    try {
      const response = await api.listSubagentModels()
      if (!response.success || !response.data) throw new Error('list-refused')
      if (mounted.current) { setSettings(response.data); setError(null) }
    } catch {
      console.warn('[SubagentModels] Settings read failed; manager remains open')
      if (mounted.current) setError(t('Could not load model assignments. Try again.'))
    }
  }
  useEffect(() => {
    mounted.current = true
    root.current?.focus({ preventScroll: true })
    void load()
    const unsubscribe = api.onSubagentModelsChanged(() => {
      if (editingRef.current) {
        setChangeNotice(t('Assignments changed elsewhere. Your open draft is preserved; saving it will check for conflicts.'))
      } else void load()
    })
    return () => { mounted.current = false; unsubscribe() }
  }, [])
  const setSaving = (value: boolean) => {
    busyRef.current = value
    setBusy(value)
    onBusyChange(value)
  }
  useLayoutEffect(() => {
    if (!restoreFocus.current || busy || editing) return
    restoreFocus.current = false
    const entry = trigger.current?.isConnected ? trigger.current : root.current
    entry?.focus({ preventScroll: true })
  }, [busy, editing])

  const closeEditor = () => {
    restoreFocus.current = true
    editingRef.current = null
    onDraftChange(false)
    setEditing(null)
    setChangeNotice(null)
  }
  const saved = (next: SubagentModelSettings) => {
    setSettings(next)
    closeEditor()
  }
  const open = (id: string, element: HTMLElement) => {
    if (busyRef.current || editing) return
    trigger.current = element
    editingRef.current = id
    onDraftChange(true)
    setEditing(id)
  }
  const changeMode = async (selectionMode: 'inherit' | 'task') => {
    if (!settings || busyRef.current) return
    setSaving(true)
    setError(null)
    try {
      const result = await api.setSubagentModelSelectionMode({ selectionMode, expectedRevision: settings.revision })
      if (!result.success || !result.data) {
        console.warn(`[SubagentModels] Selection mode save refused code=${result.code ?? 'unknown'}`)
        setError(t('Could not change the default selection. Settings may have changed elsewhere. Try again.'))
        return
      }
      setSettings(result.data)
    } catch {
      console.warn('[SubagentModels] Selection mode save failed; previous mode retained')
      setError(t('Could not change the default selection. Try again.'))
    } finally { setSaving(false) }
  }
  const remove = async (profile: SubagentModelProfile) => {
    if (!settings || busyRef.current || editing) return
    const last = settings.profiles.filter(item => item.target).length === 1 && !!profile.target
    const accepted = await showConfirm({
      title: profile.kind === 'builtin' ? t('Clear “{{name}}”?', { name: profileName(profile) }) : t('Delete “{{name}}”?', { name: profileName(profile) }),
      message: [t('Future subtasks will no longer use this assignment. Existing tasks keep the model they were created with and will not be stopped.'), ...(last ? [t('This is the last configured target. Default selection will return to Inherit parent Agent.')] : [])].join('\n\n'),
      confirmLabel: profile.kind === 'builtin' ? t('Clear configuration') : t('Delete'), cancelLabel: t('Cancel'), variant: 'danger',
    })
    if (!accepted) return
    setSaving(true)
    setError(null)
    try {
      const input = { id: profile.id, expectedRevision: profile.revision }
      const result = profile.kind === 'builtin' ? await api.clearBuiltinSubagentModel(input) : await api.deleteSubagentModel(input)
      if (!result.success || !result.data) {
        console.warn(`[SubagentModels] Assignment removal refused code=${result.code ?? 'unknown'}`)
        setError(t('Could not remove this configuration. It may have changed elsewhere. Try again.'))
        return
      }
      setSettings(result.data)
    } catch {
      console.warn('[SubagentModels] Assignment removal failed; configuration retained')
      setError(t('Could not remove this configuration. Try again.'))
    } finally { setSaving(false) }
  }
  const builtins = settings?.profiles.filter(item => item.kind === 'builtin') ?? []
  const custom = settings?.profiles.filter(item => item.kind === 'custom') ?? []
  const lastPage = Math.max(0, Math.ceil(custom.length / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  const bound = settings?.profiles.some(item => item.target) ?? false
  const row = (profile: SubagentModelProfile) => <div key={profile.id} data-subagent-profile-id={profile.id} className="min-w-0 border-t border-border-faint py-4">
    <div className="flex flex-col items-start justify-between gap-1 sm:flex-row sm:gap-3">
      <div className="min-w-0"><h4 className="break-words text-sm font-medium">{profileName(profile)}</h4><p className="mt-1 break-words text-sm text-muted-foreground">{targetLabel(profile.target, config, t)}</p><p className="mt-1 break-words text-xs text-muted-foreground">{profilePurpose(profile, t)}</p></div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 sm:items-start"><button type="button" disabled={busy || !!editing} onClick={event => open(profile.id, event.currentTarget)} className="min-h-11 rounded-md px-2 text-sm text-primary hover:bg-secondary disabled:opacity-40 sm:min-h-9">{profile.target ? t('Edit') : t('Configure')}</button>{(profile.target || profile.kind === 'custom') && <button type="button" disabled={busy || !!editing} onClick={() => void remove(profile)} className="min-h-11 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-40 sm:min-h-9">{profile.kind === 'builtin' ? t('Clear configuration') : t('Delete')}</button>}</div>
    </div>
    {editing === profile.id && <ProfileEditor key={profile.id} profile={profile} config={config} onSaved={saved} onCancel={() => { closeEditor(); void load() }} onBusyChange={setSaving} />}
  </div>
  return <section ref={root} tabIndex={-1} data-subagent-models-manager aria-label={t('Model assignments')} className="min-w-0 space-y-4 outline-none">
    <p className="text-sm text-muted-foreground">{t('Choose models for different tasks')}</p>
    {changeNotice && <p role="status" className="text-sm text-muted-foreground">{changeNotice}</p>}
    {error && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><button type="button" disabled={busy || !!editing} onClick={() => void load()} className="min-h-11 rounded px-2 text-sm text-primary sm:min-h-9">{t('Reload settings')}</button></div>}
    {!settings ? <p role="status" className="text-sm text-muted-foreground">{t('Loading...')}</p> : <>
      <div className="space-y-2"><label htmlFor="subagent-default-selection" className="block text-sm font-medium">{t('Default selection')}</label><select id="subagent-default-selection" value={settings.selectionMode} disabled={busy} onChange={event => void changeMode(event.target.value as 'inherit' | 'task')} className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm sm:w-auto"><option value="inherit">{t('Inherit parent Agent')}</option><option value="task" disabled={!bound}>{t('AI selects by task')}</option></select><p className="text-xs text-muted-foreground">{t('Only affects new subagents, not the main Agent. By default they inherit the parent’s model. You can name an assignment or model in your task; automatic selection uses the purposes you provide.')}</p>{!bound && <p className="text-xs text-muted-foreground">{t('Configure at least one target to enable task-based selection.')}</p>}</div>
      <div>{builtins.map(row)}{custom.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(row)}</div>
      <p className="text-xs text-muted-foreground">{t('Unconfigured tiers are not used. You do not need to fill every tier.')}</p>
      {lastPage > 0 && <nav aria-label={t('Custom assignments')} className="flex items-center justify-between gap-2 text-sm"><button type="button" disabled={!currentPage || !!editing} onClick={() => setPage(currentPage - 1)} className="min-h-11 px-2 disabled:opacity-40">{t('Previous')}</button><span className="text-xs text-muted-foreground">{t('Page {{page}} of {{count}}', { page: currentPage + 1, count: lastPage + 1 })}</span><button type="button" disabled={currentPage === lastPage || !!editing} onClick={() => setPage(currentPage + 1)} className="min-h-11 px-2 disabled:opacity-40">{t('Next')}</button></nav>}
      {editing === 'new' ? <div className="border-t border-border-faint pt-4"><h4 className="text-sm font-medium">{t('New custom assignment')}</h4><ProfileEditor config={config} onSaved={saved} onCancel={() => { closeEditor(); void load() }} onBusyChange={setSaving} /></div> : <button type="button" disabled={busy || !!editing} onClick={event => open('new', event.currentTarget)} className="min-h-11 rounded-md px-2 text-sm text-muted-foreground hover:bg-secondary disabled:opacity-40 sm:min-h-9">{t('Add custom assignment')}</button>}
    </>}
    {!editing && <div className="flex justify-end border-t border-border-faint pt-3">
      <button type="button" disabled={busy} onClick={onClose} className={inlineFormPrimary}>{t('Done')}</button>
    </div>}
    {DialogComponent}
  </section>
}
