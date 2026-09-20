import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveEntryI18n } from '../../utils/spec-i18n'
import { StoreInstallDialog } from '../store/StoreInstallDialog'
import { CapabilityDialog } from './CapabilityDialog'
import type { RegistryEntry, StoreAppDetail, StoreQueryResponse } from '../../../shared/store/store-types'

export function CapabilityStoreDialog({ type, spaceId, onClose, onInstalled }: {
  type: 'mcp' | 'skill'; spaceId: string | null; onClose: () => void; onInstalled: (appId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<RegistryEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [detail, setDetail] = useState<StoreAppDetail | null>(null)
  const request = useRef(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    api.storeQuery({ type, search, page, pageSize: 20, locale: getCurrentLanguage() }).then(response => {
      if (cancelled) return
      if (!response.success || !response.data) throw new Error(response.error || 'Store unavailable')
      const result = response.data as StoreQueryResponse
      setItems(result.items); setHasMore(result.hasMore)
    }).catch(() => {
      if (!cancelled) { console.warn('[CapabilityStoreDialog] Store query failed', { type, page }); setError(t('Could not load the store. Check your connection and retry.')) }
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; request.current++ }
  }, [type, search, page, revision, t])
  if (detail) return <StoreInstallDialog detail={detail} initialSpaceId={spaceId} lockScope showGlobalOption={spaceId === null} onClose={() => setDetail(null)} onInstalled={async appId => {
    await useAppsStore.getState().loadApps()
    await onInstalled(appId)
    onClose()
  }} />
  return <CapabilityDialog title={type === 'skill' ? t('Browse skill store') : t('Browse MCP store')} onClose={onClose}>
    <div className="space-y-4 p-4">
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); setPage(1); setSearch(query) }}><input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('Search store')} placeholder={t('Search store')} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" /><button className="rounded-lg border border-border px-3 py-2 text-sm">{t('Search')}</button></form>
      <p className="text-xs text-muted-foreground">{type === 'skill' ? t('Installed skills will be available to everyone in this workspace. You will return to this digital human after installation.') : t('Install and enable a connection for this digital human without leaving this page.')}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error} <button onClick={() => setRevision(value => value + 1)} className="text-primary">{t('Retry')}</button></p>}
      {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : items.length === 0 ? <p className="text-sm text-muted-foreground">{t('No matching store items.')}</p> : <div className="space-y-2">{items.map(item => {
        const text = resolveEntryI18n(item, getCurrentLanguage())
        return <button key={item.slug} onClick={async () => {
          const current = ++request.current
          setLoading(true); setError(null)
          try {
            const response = await api.storeGetAppDetail(item.slug)
            if (request.current !== current) return
            if (!response.success || !response.data) throw new Error('Store detail unavailable')
            setDetail(response.data as StoreAppDetail)
          } catch { console.warn('[CapabilityStoreDialog] Store detail failed', { slug: item.slug }); setError(t('Could not load this item. Please retry.')) } finally { if (request.current === current) setLoading(false) }
        }} className="block w-full rounded-lg border border-border p-3 text-left hover:bg-secondary"><span className="block text-sm font-medium">{text.name}</span><span className="mt-1 block text-xs text-muted-foreground">{text.description}</span></button>
      })}</div>}
      <div className="flex justify-between text-sm"><button disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)} className="text-primary disabled:text-muted-foreground">{t('Previous')}</button><button disabled={!hasMore || loading} onClick={() => setPage(value => value + 1)} className="text-primary disabled:text-muted-foreground">{t('Next')}</button></div>
    </div>
  </CapabilityDialog>
}
