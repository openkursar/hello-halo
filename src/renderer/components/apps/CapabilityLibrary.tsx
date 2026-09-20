import { useState } from 'react'
import { Plus, Search, BookOpen, Plug, Loader2, ArrowUpRight } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useCapabilityInventory } from '../../hooks/useCapabilityInventory'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'

export function CapabilityLibrary({ type, onSelect, onAdd }: {
  type: 'skill' | 'mcp'; onSelect: (appId: string) => void; onAdd?: () => void
}) {
  const { t } = useTranslation()
  const apps = useAppsStore(state => state.apps)
  const appLoading = useAppsStore(state => state.isLoading)
  const appError = useAppsStore(state => state.error)
  const loadApps = useAppsStore(state => state.loadApps)
  const spaces = useSpaceStore(state => state.spaces)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const inventory = useCapabilityInventory()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [source, setSource] = useState('all')
  const statuses = useAppStore(state => state.mcpStatus)
  const scopeSpaces = [...(haloSpace ? [haloSpace] : []), ...spaces.filter(space => space.id !== haloSpace?.id)]
  const resources = apps.filter(app => app.spec.type === type && app.status !== 'uninstalled' &&
    (source === 'all' || (app.spec.store?.install_source ?? 'store') === source) &&
    (scope === 'all' || (scope === 'global' ? app.spaceId === null : app.spaceId === scope)) &&
    `${app.spec.display_name ?? app.spec.name} ${app.spec.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const Icon = type === 'skill' ? BookOpen : Plug
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h1 className="text-2xl font-semibold">{type === 'skill' ? t('Skills') : t('MCP connections')}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{type === 'skill' ? t('Reusable instructions available across your workspaces.') : t('Manage shared connections and see which digital humans use them.')}</p></div>
          {onAdd && <button onClick={onAdd} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"><Plus className="h-4 w-4" />{type === 'skill' ? t('Add skill') : t('Add connection')}</button>}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search capabilities')} aria-label={t('Search capabilities')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <select value={scope} onChange={event => setScope(event.target.value)} aria-label={t('Scope')} className="rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="all">{t('All scopes')}</option><option value="global">{t('Global')}</option>{scopeSpaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select>
          <select value={source} onChange={event => setSource(event.target.value)} aria-label={t('Source')} className="rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="all">{t('All sources')}</option><option value="store">{t('Store')}</option><option value="manual">{t('Custom')}</option><option value="builtin">{t('Built in')}</option></select>
        </div>
        {(appError || inventory.error) && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm"><p>{t('Could not load the capability library. Existing data may be out of date.')}</p><button onClick={() => { void loadApps(); inventory.reload() }} className="mt-2 text-primary">{t('Retry')}</button></div>}
        {appLoading && !apps.length ? <Loader2 className="h-5 w-5 animate-spin" /> : resources.length === 0 ? <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{query || scope !== 'all' ? t('No capabilities match these filters.') : t('No capabilities installed yet.')}</div> :
          <div className="space-y-3">{resources.map(app => {
            const text = resolveSpecI18n(app.spec, getCurrentLanguage())
            const usage = inventory.data?.entries.find(entry => entry.appId === app.id)
            const probe = type === 'mcp' && apps.filter(item => item.spec.type === 'mcp' && item.status !== 'uninstalled' && item.specId === app.specId).length === 1 ? statuses.find(status => status.name === app.specId) : undefined
            const scopeName = app.spaceId === null ? t('Global') : scopeSpaces.find(space => space.id === app.spaceId)?.name ?? t('Unavailable workspace')
            return <button key={app.id} onClick={() => onSelect(app.id)} className="flex w-full items-start gap-4 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 sm:p-5">
              <span className="rounded-lg bg-secondary p-3 text-primary"><Icon className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="font-medium">{text.name}</span><span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{scopeName}</span></span>
                <span className="mt-1 block line-clamp-2 text-sm text-muted-foreground">{text.description}</span>
                <span className="mt-3 block text-xs text-muted-foreground">{app.status === 'paused' ? t('Disabled') : app.status === 'error' ? t('Needs attention') : type === 'mcp' ? probe?.probeStatus === 'connected' ? t('Connected') : probe?.probeStatus === 'failed' ? t('Connection failed') : probe?.probeStatus === 'needs-auth' ? t('Needs login') : t('Not tested') : t('Installed')}{usage && <> · {type === 'skill' ? t('Available to {{count}} digital humans', { count: usage.consumers.length }) : t('Declared by {{count}} digital humans', { count: usage.consumers.length })}</>}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{probe?.lastCheckedAt ? t('Last checked: {{date}}', { date: new Date(probe.lastCheckedAt).toLocaleString() }) : t('Installed: {{date}}', { date: new Date(app.installedAt).toLocaleDateString() })}</span>
              </span><ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          })}</div>}
      </div>
    </div>
  )
}
