import { useEffect, useState } from 'react'
import { ChevronRight, ExternalLink, FolderOpen, Globe, Loader2, Plus, RefreshCw, Search, Upload } from 'lucide-react'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { useSkillActions } from '../../hooks/useSkillActions'
import { useSkillInventory } from '../../hooks/useSkillInventory'
import { selectedSkill, skillDisplay, skillInstructions } from '../../utils/skill-presentation'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { CapabilityStoreDialog } from './CapabilityStoreDialog'
import { ExistingSkillDialog } from './ExistingSkillDialog'
import { SkillInstallDialog } from './SkillInstallDialog'
import { SkillInfoCard } from './SkillInfoCard'
import { CapabilityDialog } from './CapabilityDialog'
import type { SkillDetail, SkillGroup } from '../../../shared/types/skills'

function SkillRow({ group, spaceId, onOpen, onChanged }: { group: SkillGroup; spaceId: string | null; onOpen: () => void; onChanged: () => void }) {
  const { t } = useTranslation()
  const copy = selectedSkill(group)
  const actions = useSkillActions({ spaceId, id: copy?.id ?? '' }, onChanged)
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!expanded || !copy) return
    let cancelled = false
    setDetail(null); setFailed(false)
    api.skillsRead({ spaceId, id: copy.id }).then(result => {
      if (cancelled) return
      if (result.success && result.data) setDetail(result.data)
      else { console.warn('[AppSkillsSection] Skill preview failed', { id: copy.id }); setFailed(true) }
    }).catch(() => { if (!cancelled) { console.warn('[AppSkillsSection] Skill preview failed', { id: copy.id }); setFailed(true) } })
    return () => { cancelled = true }
  }, [expanded, copy?.id, spaceId])
  if (!copy) return null
  const display = skillDisplay(copy, getCurrentLanguage())
  const body = detail ? skillInstructions(detail.content) : ''
  const connections = detail?.spec.requires?.mcps?.map(mcp => typeof mcp === 'string' ? mcp : mcp.id).join(', ')
  return <div className="rounded-lg border border-border-soft bg-secondary/40">
    <div className="flex items-center gap-2.5 px-3 py-2">
      <button onClick={() => setExpanded(value => !value)} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-1.5 text-left"><ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} /><span className="truncate text-sm text-foreground">{display.name}</span></button>
      {!copy.enabled && <span className="text-[11px] text-muted-foreground">{t('Disabled')}</span>}
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{copy.scope === 'global' && <Globe className="h-3 w-3" />}{copy.scope === 'global' ? t('Global') : t('This workspace')}</span>
      {isElectron() && (
        <button
          type="button"
          title={t('Open skill folder')}
          aria-label={t('Open skill folder')}
          disabled={actions.busy || copy.availability === 'missing'}
          onClick={event => { event.stopPropagation(); void actions.openFolder() }}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
    {actions.error && <p role="alert" className="px-3 pb-2 text-xs text-halo-error">{actions.error}</p>}
    {expanded && <div className="space-y-2.5 border-t border-border-faint px-3 pb-3 pt-2">
      <p className="text-xs leading-relaxed text-muted-foreground">{display.description}</p>
      {connections && <p className="break-words text-xs text-muted-foreground">{t('Required connections: {{names}}', { names: connections })}</p>}
      {failed ? <p className="text-xs text-halo-error">{t('Could not open this skill. Please try again.')}</p> : detail ? <div className="max-h-80 overflow-auto rounded-lg border border-border-soft bg-secondary/40 p-3 text-sm"><MarkdownRenderer content={body ?? ''} mode="static" /></div> : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      <button onClick={onOpen} className="inline-flex items-center gap-1 text-xs text-primary"><ExternalLink className="h-3 w-3" />{t('Open skill detail')}</button>
    </div>}
  </div>
}

export function AppSkillsSection({ appId, spaceId }: { appId: string; spaceId: string | null }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<SkillGroup | null>(null)
  const [addMode, setAddMode] = useState<'visual' | 'import' | null>(null)
  const [chooseExisting, setChooseExisting] = useState(false)
  const [showStore, setShowStore] = useState(false)
  const contextKey = `${appId}:${spaceId}`
  const [viewContext, setViewContext] = useState(contextKey)
  if (viewContext !== contextKey) {
    setViewContext(contextKey); setSelected(null); setOffset(0); setQuery('')
    setAddMode(null); setChooseExisting(false); setShowStore(false)
  }
  const contextChanged = viewContext !== contextKey
  const inventory = useSkillInventory({ spaceId, q: contextChanged ? '' : query, offset: contextChanged ? 0 : offset, limit: 50 })
  const buttonClass = 'inline-flex items-center gap-1.5 rounded-md border border-border-soft px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40'
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('Skills')}{!!inventory.data?.total && <span className="ml-1.5 font-normal text-muted-foreground">({inventory.data.total})</span>}</h3><div className="flex flex-wrap gap-1.5"><button onClick={() => setChooseExisting(true)} className={buttonClass}>{t('Choose existing')}</button><button onClick={() => setAddMode('visual')} className={buttonClass}><Plus className="h-3.5 w-3.5" />{t('New skill')}</button><button onClick={() => setAddMode('import')} className={buttonClass}><Upload className="h-3.5 w-3.5" />{t('Import')}</button><button onClick={inventory.refresh} disabled={inventory.loading} aria-label={t('Refresh')} title={t('Refresh')} className={buttonClass}><RefreshCw className="h-3.5 w-3.5" /></button></div></div>
    <p className="text-xs text-muted-foreground">{t('Skills in this workspace and global skills are available here.')}</p>
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input aria-label={t('Search skills')} placeholder={t('Search skills')} value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} className="w-full rounded-lg border border-border-soft bg-background py-2 pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary" /></div>
    {inventory.error && <p role="alert" className="text-xs text-halo-error">{t('Could not load available skills.')} <button onClick={inventory.refresh} className="underline">{t('Retry')}</button></p>}
    {inventory.loading && !inventory.data && <p role="status" className="text-xs text-muted-foreground">{t('Loading…')}</p>}
    {inventory.data?.groups.map(group => <SkillRow key={`${contextKey}:${group.name}`} group={group} spaceId={spaceId} onOpen={() => setSelected(group)} onChanged={inventory.refresh} />)}
    {!inventory.loading && inventory.data?.groups.length === 0 && (query.trim()
      ? <p className="text-xs text-muted-foreground">{t('No matching skills.')}</p>
      : <div className="space-y-2 rounded-lg border border-dashed border-border p-4 text-center">
          <p className="text-xs text-muted-foreground">{t('No skills available in this workspace yet.')}</p>
          <button onClick={() => setShowStore(true)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/10"><ExternalLink className="h-3 w-3" />{t('Browse skill store')}</button>
        </div>)}
    <div className="flex flex-wrap items-center gap-3">{inventory.data && inventory.data.total > 50 && <><button disabled={offset === 0 || inventory.loading} onClick={() => setOffset(value => Math.max(0, value - 50))} className={buttonClass}>{t('Previous')}</button><button disabled={offset + inventory.data.groups.length >= inventory.data.total || inventory.loading} onClick={() => setOffset(value => value + 50)} className={buttonClass}>{t('Next')}</button></>}<button onClick={() => setShowStore(true)} className="text-xs text-primary hover:underline">{t('Browse skill store')}</button></div>
    {!contextChanged && selected && <CapabilityDialog title={t('Shared skill settings')} onClose={() => setSelected(null)}><SkillInfoCard skillRef={{ spaceId, id: selected.effectiveId ?? selected.copies[0].id }} group={selected} showUse={false} stickyHeader={false} onChanged={inventory.refresh} onDeleted={() => { setSelected(null); inventory.refresh() }} /></CapabilityDialog>}
    {showStore && <CapabilityStoreDialog type="skill" spaceId={spaceId} onClose={() => setShowStore(false)} onInstalled={async () => inventory.refresh()} />}
    {chooseExisting && <ExistingSkillDialog spaceId={spaceId} onClose={() => setChooseExisting(false)} onAdded={inventory.refresh} />}
    {addMode && <SkillInstallDialog draftKey={appId} initialMode={addMode} initialSpaceId={spaceId} onClose={() => setAddMode(null)} onInstalled={inventory.refresh} />}
  </div>
}
