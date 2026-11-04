import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, Loader2, Plus, Puzzle, RefreshCw, Search, Store } from 'lucide-react'
import type { LegacySkill, SkillGroup, SkillGroupSource, SkillListQuery } from '../../../shared/types/skills'
import { useSkillInventory } from '../../hooks/useSkillInventory'
import { useTranslation } from '../../i18n'
import { useSpaceStore } from '../../stores/space.store'
import { SkillCard } from './SkillCard'

interface SkillCardWallProps {
  spaceMap: Record<string, string>
  onBrowseStore: () => void
  onManualAdd: (spaceId: string | null) => void
  onOpen: (group: SkillGroup, spaceId: string | null) => void
  onOpenLegacy?: (skill: LegacySkill) => void
}

const pageSize = 50
const sources: SkillGroupSource[] = ['mine', 'digital-human', 'builtin']

interface SkillScopeProps extends Pick<SkillCardWallProps, 'spaceMap' | 'onOpen' | 'onOpenLegacy'> {
  spaceId: string | null
  q: string
  source: SkillListQuery['source']
  workspaceOnly?: boolean
  toolbar?: (refresh: () => void, loading: boolean, empty: boolean) => ReactNode
  emptyActions?: ReactNode
  onClearFilters?: () => void
}

function SkillScope({ spaceId, q, source, spaceMap, onOpen, onOpenLegacy, workspaceOnly = false, toolbar, emptyActions, onClearFilters }: SkillScopeProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState({ scope: '', offset: 0 })
  const scope = JSON.stringify([spaceId, q, source])
  const offset = page.scope === scope ? page.offset : 0
  const [expanded, setExpanded] = useState<Set<SkillGroupSource>>(new Set())
  const { data, loading, error, refresh } = useSkillInventory({ spaceId, q, source: workspaceOnly ? 'all' : source, offset, limit: pageSize })
  const labels: Record<SkillGroupSource, string> = { mine: t('My skills'), 'digital-human': t('Digital human skills'), builtin: t('Built-in skills') }
  const groups = useMemo(() => {
    if (!workspaceOnly) return data?.groups ?? []
    return (data?.groups ?? []).flatMap(group => {
      const copies = group.copies.filter(copy => copy.spaceId === spaceId)
      if (q && !copies.some(copy => `${copy.name} ${copy.displayName} ${copy.description}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()))) return []
      const selected = copies.find(copy => copy.id === group.effectiveId) ?? copies[0]
      if (!selected) return []
      const localSource = copies.some(copy => copy.source === 'personal' || copy.source === 'store') ? 'mine'
        : copies.some(copy => copy.source === 'digital-human') ? 'digital-human' : 'builtin'
      if (source !== 'all' && source !== localSource) return []
      return [{ ...group, copies, effectiveId: copies.some(copy => copy.id === group.effectiveId) ? group.effectiveId : undefined,
        displayName: selected.displayName, description: selected.description, source: localSource as SkillGroupSource }]
    })
  }, [data, workspaceOnly, spaceId, source, q])
  const empty = !workspaceOnly && data?.total === 0 && !q && source === 'all' && !data.warnings.length && !error && !loading
  const toggleExpanded = (value: SkillGroupSource) => setExpanded(previous => {
    const next = new Set(previous); if (next.has(value)) next.delete(value); else next.add(value); return next
  })
  const removed = data?.legacyRemoved.filter(skill => !workspaceOnly || skill.spaceId === spaceId) ?? []

  return <>
    {toolbar?.(refresh, loading, empty)}
    <div className={toolbar ? 'min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-10' : 'min-w-0 space-y-3'} aria-busy={loading}>
      {!toolbar && <div className="flex justify-end"><button type="button" onClick={refresh} disabled={loading} aria-label={t('Refresh skills')} className="rounded-md p-2 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button></div>}
      {loading && !data && <p role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Loading skills…')}</p>}
      {error && <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border-soft px-4 py-3 text-sm"><span className="text-muted-foreground">{t('Could not refresh your skills. Please try again.')}</span><button type="button" onClick={refresh} disabled={loading} className="shrink-0 text-primary disabled:opacity-50">{t('Retry')}</button></div>}
      {!!data?.warnings.length && <p role="status" className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{t('Some skills could not be loaded. Your other skills are still available.')}<button type="button" onClick={refresh} disabled={loading} className="text-primary disabled:opacity-50">{t('Retry')}</button></p>}
      {empty ? <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-center"><div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary"><Puzzle className="h-6 w-6 text-muted-foreground" /></div><div><p className="text-sm font-medium">{t('No Skills installed yet')}</p><p className="mt-1 max-w-xs text-xs text-muted-foreground">{t('Browse the marketplace for ready-made Skills, or add one manually')}</p></div><div className="flex flex-wrap justify-center gap-2">{emptyActions}</div></div>
        : data && !loading && groups.length === 0 && !error ? <div className="py-12 text-center"><p className="text-sm text-muted-foreground">{workspaceOnly ? t('No workspace skills on this page.') : t('No matching Skills')}</p>{(q || source !== 'all') && onClearFilters && <button onClick={onClearFilters} className="mt-2 text-xs text-primary hover:underline">{t('Clear filters')}</button>}</div> : null}
      <div className="space-y-5">{sources.map(value => {
        const sourceGroups = groups.filter(group => group.source === value)
        if (!sourceGroups.length) return null
        const open = value === 'mine' || Boolean(q) || source !== 'all' || expanded.has(value)
        return <section key={value}><button type="button" onClick={() => toggleExpanded(value)} aria-expanded={open} disabled={value === 'mine' || Boolean(q) || source !== 'all'} className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"><span>{labels[value]}</span><span className="font-normal normal-case tracking-normal">({sourceGroups.length})</span>{value !== 'mine' && <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />}</button>{open && <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">{sourceGroups.map(group => <SkillCard key={group.name} group={group} spaceMap={spaceMap} contextSpaceId={spaceId} onChanged={refresh} onOpen={() => onOpen(group, spaceId)} />)}</div>}</section>
      })}</div>
      {data && (data.total > pageSize || offset > 0) && <nav aria-label={t('Skill pages')} className="mt-6 flex items-center justify-between gap-2 text-xs text-muted-foreground"><button disabled={loading || offset === 0} onClick={() => setPage({ scope, offset: Math.max(0, offset - pageSize) })} className="rounded-md border border-border-soft px-3 py-1.5 disabled:opacity-40">{t('Previous')}</button><span>{workspaceOnly ? t('Page {{page}}', { page: Math.floor(offset / pageSize) + 1 }) : t('{{count}} skills', { count: data.total })}</span><button disabled={loading || offset + data.groups.length >= data.total} onClick={() => setPage({ scope, offset: offset + pageSize })} className="rounded-md border border-border-soft px-3 py-1.5 disabled:opacity-40">{t('Next')}</button></nav>}
      {workspaceOnly && data && data.total > pageSize && <p className="text-xs text-muted-foreground">{t('Pages include global skills, shown only in the Global section.')}</p>}
      {removed.length > 0 && <details className="mt-6 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('Previously removed skills')} ({removed.length})</summary><div className="mt-3 space-y-2">{removed.map(skill => <div key={skill.appId} className="flex items-center justify-between gap-2"><span className="truncate">{skill.name}</span>{onOpenLegacy && <button type="button" className="shrink-0 text-primary" onClick={() => onOpenLegacy(skill)}>{t('View removed skill')}</button>}</div>)}</div></details>}
    </div>
  </>
}

function WorkspaceSkills({ name, ...props }: SkillScopeProps & { name: string }) {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  return <section aria-label={name} className="space-y-3 rounded-lg border border-border-soft p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-words text-sm font-semibold">{name}</h3><button type="button" onClick={() => setLoaded(value => !value)} aria-expanded={loaded} className="shrink-0 text-xs text-primary">{loaded ? t('Hide skills') : t('Load skills')}</button></div>
    {loaded ? <SkillScope {...props} workspaceOnly={props.spaceId !== null} /> : <p className="text-xs text-muted-foreground">{t('Skills have not been loaded for this workspace.')}</p>}
  </section>
}

export function SkillCardWall({ spaceMap, onBrowseStore, onManualAdd, onOpen, onOpenLegacy }: SkillCardWallProps) {
  const { t } = useTranslation()
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)
  const [selectedSpace, setSelectedSpace] = useState<string | null | undefined>(undefined)
  const allWorkspaces = selectedSpace === 'all'
  const spaceId = selectedSpace === undefined || allWorkspaces ? currentSpace?.id ?? haloSpace?.id ?? null : selectedSpace
  const [search, setSearch] = useState('')
  const [q, setQuery] = useState('')
  const [source, setSource] = useState<SkillListQuery['source']>('all')
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 300); return () => clearTimeout(timer) }, [search])
  const spaceOptions = useMemo(() => {
    const options = new Map(spaces.map(space => [space.id, space]))
    if (haloSpace) options.set(haloSpace.id, haloSpace)
    if (currentSpace) options.set(currentSpace.id, currentSpace)
    return Array.from(options.values())
  }, [spaces, haloSpace, currentSpace])
  const labels: Record<SkillGroupSource, string> = { mine: t('My skills'), 'digital-human': t('Digital human skills'), builtin: t('Built-in skills') }
  const filterClass = 'appearance-none min-w-0 w-full rounded-lg border border-border-soft bg-card py-2 pl-3 pr-8 text-[13px] text-muted-foreground transition-colors hover:border-border hover:text-foreground focus:outline-none focus:ring-1 focus:ring-primary'
  const addButtons = <>
    <button type="button" aria-label={t('Manual Add Skill')} onClick={() => onManualAdd(spaceId)} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 py-2 text-[13px] text-primary-foreground transition-colors hover:bg-primary/90 sm:px-3"><Plus className="h-4 w-4" /><span className="sm:hidden">{t('Add')}</span><span className="hidden sm:inline">{t('Manual Add Skill')}</span></button>
    <button type="button" aria-label={t('Install from Marketplace')} onClick={onBrowseStore} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/10 px-2.5 py-2 text-[13px] text-accent-on-dark transition-colors hover:bg-primary/20 sm:px-3"><Store className="h-4 w-4" /><span className="sm:hidden">{t('Store')}</span><span className="hidden sm:inline">{t('Install from Marketplace')}</span></button>
  </>
  const filters = (refresh?: () => void, loading = false, empty = false) => <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5 sm:px-10">
    <div className="relative min-w-[150px] flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input className="w-full rounded-lg border border-border-soft bg-card py-2 pl-9 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary" value={search} onChange={event => setSearch(event.target.value)} placeholder={allWorkspaces ? t('Search loaded workspaces') : t('Search skills')} aria-label={t('Search skills')} /></div>
    <div className="relative max-w-full"><select className={filterClass} value={allWorkspaces ? 'all' : spaceId ?? ''} onChange={event => setSelectedSpace(event.target.value || null)} aria-label={t('Workspace')}><option value="">{t('Global')}</option><option value="all">{t('All workspaces')}</option>{spaceOptions.map(space => <option key={space.id} value={space.id}>{space.isTemp ? t('Halo') : space.name}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /></div>
    <div className="relative min-w-[104px] flex-1 sm:flex-none"><select className={filterClass} value={source} onChange={event => setSource(event.target.value as SkillListQuery['source'])} aria-label={t('Source')}><option value="all">{t('All sources')}</option>{sources.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /></div>
    <div className="flex shrink-0 items-center gap-1.5">{refresh && <button type="button" onClick={refresh} disabled={loading} aria-label={t('Refresh skills')} title={t('Refresh skills')} className="rounded-md p-2 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>}{!empty && <><div className="mx-2 hidden h-5 w-px shrink-0 bg-border sm:block" />{addButtons}</>}</div>
  </div>
  const scopeProps = { q, source, spaceMap, onOpen, onOpenLegacy, onClearFilters: () => { setSearch(''); setSource('all') } }
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {allWorkspaces ? <>
      {filters()}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 sm:px-10">
        <p className="text-xs text-muted-foreground">{t('Load each workspace to inspect its skills. Search applies only to loaded workspaces; global skills appear once in Global.')}</p>
        <WorkspaceSkills {...scopeProps} name={t('Global')} spaceId={null} />
        {spaceOptions.map(space => <WorkspaceSkills key={space.id} {...scopeProps} name={space.isTemp ? t('Halo') : space.name} spaceId={space.id} />)}
      </div>
    </> : <SkillScope {...scopeProps} spaceId={spaceId} toolbar={filters} emptyActions={addButtons} />}
  </div>
}
