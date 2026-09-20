import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUpRight } from 'lucide-react'
import type { ActivityEntry, PendingDecisionQuery } from '../../../shared/apps/app-types'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { usePeopleViewStore } from '../../stores/people-view.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { ActivitySource } from './ActivitySource'
import { EscalationCard } from './EscalationCard'
import { AutomationAvatar } from './AutomationAvatar'
import { mergeActivityEntries, isPendingDecision } from '../../utils/people-model'

export function PeopleInbox() {
  const { t } = useTranslation()
  const apps = useAppsStore(state => state.apps)
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [total, setTotal] = useState<number | null>(null)
  const [cursor, setCursor] = useState<PendingDecisionQuery | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [received, setReceived] = useState(false)
  const generation = useRef(0)
  const load = useCallback(async (after?: PendingDecisionQuery) => {
    const current = ++generation.current
    setLoading(true); setFailed(false)
    try {
      const result = await api.appGetPendingInbox({ limit: 30, ...after })
      if (!result.success || !result.data) throw new Error(result.error ?? 'Inbox request rejected')
      if (current !== generation.current) return
      const page = result.data.entries
      setEntries(previous => after ? mergeActivityEntries(previous, page).reverse() : page)
      setNames(previous => after ? { ...previous, ...result.data!.names } : result.data!.names)
      setTotal(result.data.total)
      const last = page[page.length - 1]
      setCursor(page.length === 30 && last ? { afterTs: last.ts, afterId: last.id } : null)
    } catch (error) {
      if (current === generation.current) setFailed(true)
      console.warn('[PeopleInbox] Decision inbox unavailable', { error })
    } finally { if (current === generation.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.onAppActivityEntry(event => {
      const entry = (event as { entry?: ActivityEntry }).entry
      if (!entry || entry.type !== 'escalation') return
      ++generation.current
      setEntries(previous => previous.map(item => item.id === entry.id ? entry : item))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), 200)
    })
    return () => { ++generation.current; off(); if (timer) clearTimeout(timer) }
  }, [load])
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-8"><div className="mx-auto max-w-3xl"><header className="mb-6"><h1 className="text-2xl font-semibold">{t('Needs my attention')} {total !== null && <span className="text-base font-normal text-muted-foreground">{total}</span>}</h1><p className="mt-2 text-sm text-muted-foreground">{t('Requests from your digital humans and teams. Answering continues only the original work.')}</p></header>
    {failed && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t('Could not load requests.')} <button onClick={() => void load()} className="underline">{t('Retry')}</button></p>}
    {received && <p role="status" className="mb-4 rounded-lg bg-halo-success/10 p-3 text-sm text-halo-success">{t('Your answer was received. Follow the original work for continuation status.')}</p>}
    {loading && !entries.length && <p role="status" className="py-10 text-center text-muted-foreground">{t('Loading requests…')}</p>}
    {!loading && !failed && !entries.some(isPendingDecision) && <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground"><AlertCircle className="mx-auto mb-3" /><p>{t('No requests waiting for you.')}</p></div>}
    {entries.filter(isPendingDecision).map(entry => {
      const app = apps.find(item => item.id === entry.appId)
      return <article key={entry.id} className="mb-4 rounded-xl border border-border border-l-[3px] border-l-halo-warning/60 p-4"><button onClick={() => { usePeopleViewStore.setState({ returnInbox: true, returnTeam: null, focusEntry: { appId: entry.appId, entryId: entry.id } }); useAppsPageStore.getState().openActivityThread(entry.appId); useAppsPageStore.getState().setCurrentTab('my-digital-humans') }} className="mb-3 flex min-h-9 items-center gap-2 text-sm"><AutomationAvatar name={names[entry.appId] ?? app?.spec.name ?? entry.appId} size={28} /><span>{names[entry.appId] ?? app?.spec.name ?? t('Digital human')}</span><ArrowUpRight size={13} className="text-muted-foreground" /></button><ActivitySource entry={entry} />{expanded === entry.id ? <EscalationCard entry={entry} appId={entry.appId} onResolved={() => { setReceived(true); setExpanded(null); void load() }} /> : <><p className="whitespace-pre-wrap break-words text-sm">{entry.content.summary}</p><button onClick={() => setExpanded(entry.id)} className="mt-3 min-h-9 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">{t('Review and answer')}</button></>}</article>
    })}
    {cursor && <button disabled={loading} onClick={() => void load(cursor)} className="min-h-10 w-full rounded-lg border border-border text-sm disabled:opacity-50">{loading ? t('Loading…') : t('Load more requests')}</button>}
  </div></div>
}
