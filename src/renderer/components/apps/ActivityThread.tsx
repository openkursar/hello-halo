import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUpRight, CalendarClock, Loader2 } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { usePeopleViewStore } from '../../stores/people-view.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { ActivityEntryCard } from './ActivityEntryCard'
import { ActivitySource } from './ActivitySource'
import { EscalationCard } from './EscalationCard'
import { activitySourceKind, isPendingDecision } from '../../utils/people-model'
import { PersonTeamWork } from './PersonTeamWork'
import { PersonTeams } from './PersonTeams'

export function ActivityThread({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const entries = useAppsStore(state => state.activityEntries[appId]) ?? []
  const pending = useAppsStore(state => state.pendingEntries[appId]) ?? []
  const state = useAppsStore(store => store.appStates[appId])
  const pendingHasMore = useAppsStore(store => store.pendingHasMore[appId])
  const [pendingLoading, setPendingLoading] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState(false)
  const hasMore = useAppsStore(store => store.activityHasMore[appId])
  const failed = useAppsStore(store => store.activityErrors[appId])
  const app = useAppsStore(store => store.apps.find(item => item.id === appId))
  const focusEntry = usePeopleViewStore(view => view.focusEntry)
  const [focusError, setFocusError] = useState(false)
  const [source, setSource] = useState('all')
  const [initialLoading, setInitialLoading] = useState(true)
  const [historySnapshot, setHistorySnapshot] = useState<string[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingLimit, setPendingLimit] = useState(5)
  const [loading, setLoading] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const refresh = () => Promise.all([useAppsStore.getState().loadActivity(appId), useAppsStore.getState().loadPending(appId), useAppsStore.getState().loadAppState(appId)])
  useEffect(() => {
    let disposed = false
    setInitialLoading(true); setHistorySnapshot(null); setExpanded(null); setPendingLimit(5)
    void refresh().finally(() => { if (!disposed) setInitialLoading(false) })
    const off = api.onAppEscalationResolved(event => {
      const payload = event as { appId?: string }
      if (payload.appId === appId) void refresh()
    })
    return () => { disposed = true; off() }
  }, [appId])
  useEffect(() => {
    if (!focusEntry || focusEntry.appId !== appId) return
    let disposed = false
    setFocusError(false)
    setHistorySnapshot(null); setSource('all')
    void api.appGetActivityEntry(appId, focusEntry.entryId).then(result => {
      if (disposed) return
      if (!result.success || !result.data) throw new Error(result.error ?? 'Requested record unavailable')
      useAppsStore.getState().handleNewActivityEntry(appId, result.data)
      setExpanded(focusEntry.entryId)
      requestAnimationFrame(() => {
        const target = document.getElementById(`activity-${focusEntry.entryId}`)
        target?.scrollIntoView({ block: 'center' })
        target?.focus({ preventScroll: true })
        usePeopleViewStore.setState({ focusEntry: null })
      })
    }).catch(error => {
      if (!disposed) { console.warn('[ActivityThread] Requested activity unavailable', { appId, entryId: focusEntry.entryId, error }); setFocusError(true) }
    })
    return () => { disposed = true }
  }, [appId, focusEntry])
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = usePeopleViewStore.getState().scrolls[`activity:${appId}`] ?? 0 }, [appId])
  const active = pending.filter(isPendingDecision)
  const visiblePending = active.slice(0, pendingLimit)
  const focusedPending = active.find(entry => entry.id === expanded)
  if (focusedPending && !visiblePending.some(entry => entry.id === focusedPending.id)) visiblePending.unshift(focusedPending)
  const newCount = historySnapshot ? entries.filter(entry => !historySnapshot.includes(entry.id)).length : 0
  const history = entries.filter(entry => !historySnapshot || historySnapshot.includes(entry.id)).filter(entry => !active.some(item => item.id === entry.id)).filter(entry => source === 'all' || activitySourceKind(entry) === source)
  const paused = state?.automaticEnabled === false || app?.status === 'paused'
  const busy = state?.status === 'running' || state?.status === 'queued'
  return <div ref={scroll} onScroll={event => { usePeopleViewStore.getState().saveScroll(`activity:${appId}`, event.currentTarget.scrollTop); if (event.currentTarget.scrollTop > 100) setHistorySnapshot(current => current ?? entries.map(entry => entry.id)) }} className="h-full overflow-y-auto p-4 sm:p-8">
    <div className="mx-auto grid max-w-6xl gap-8 xl:grid-cols-[minmax(0,1fr)_250px]">
      <main className="min-w-0">
        {focusError && <p role="alert" className="mb-4 text-sm text-halo-warning">{t('This activity is unavailable. Other work remains accessible.')}</p>}
        {initialLoading && <p role="status" className="mb-4 text-sm text-muted-foreground">{t('Loading work…')}</p>}
        {failed && <div role="alert" className="mb-5 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t('Some work records could not be loaded.')} <button onClick={() => void refresh()} className="underline">{t('Retry')}</button></div>}
        <section className="mb-7" aria-label={t('Needs your answer')}><h2 className="mb-4 text-base font-medium">{t('Needs your answer')} <span className="ml-2 text-sm text-muted-foreground">{state?.pendingDecisionCount ?? active.length}</span></h2>
          {!active.length && !failed && !initialLoading && <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">{t('No requests waiting for you.')}</p>}
          {visiblePending.map(entry => <div key={entry.id} id={`activity-${entry.id}`} tabIndex={-1} className="mb-3 rounded-xl border border-border border-l-[3px] border-l-halo-warning/60 p-4"><ActivitySource entry={entry} /><h3 className="mb-2 whitespace-pre-wrap break-words text-sm font-medium">{entry.content.summary}</h3>{expanded === entry.id ? <EscalationCard entry={entry} appId={appId} onResolved={() => { setExpanded(null); setHistorySnapshot(null); void refresh() }} /> : <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{entry.content.deadlineAt ? t('Due {{date}}', { date: new Date(entry.content.deadlineAt).toLocaleString() }) : t('Waiting for your decision')}</span><button onClick={() => setExpanded(entry.id)} className="min-h-9 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">{t('Review and answer')}</button></div>}</div>)}
          {(active.length > pendingLimit || pendingHasMore) && <button disabled={pendingLoading} onClick={async () => { if (active.length <= pendingLimit && pendingHasMore) { setPendingLoading(true); try { await useAppsStore.getState().loadMorePending(appId) } finally { setPendingLoading(false) } } setPendingLimit(value => value + 10) }} className="min-h-9 text-sm text-primary">{t('Show more requests')}</button>}
        </section>
        {busy && <section className="mb-7 rounded-xl border border-primary/25 bg-primary/5 p-4"><h2 className="flex items-center gap-2 text-sm font-medium"><Loader2 size={16} className="animate-spin" />{state?.status === 'queued' ? t('Independent execution queued') : t('Independent execution in progress')}</h2>{state?.runningRunId && state.runningSessionKey && <button onClick={() => useAppsPageStore.getState().openSessionDetail(appId, state.runningRunId!, state.runningSessionKey!)} className="mt-3 flex min-h-8 items-center gap-1 text-xs text-primary">{t('View process')}<ArrowUpRight size={13} /></button>}{state?.runningRunId && state.status === 'running' && <button disabled={stopping} onClick={async () => { setStopping(true); setStopError(false); try { const result = await api.appStopRun(appId, state.runningRunId!); if (!result.success) throw new Error(result.error ?? 'Stop rejected'); await refresh() } catch (error) { console.warn('[ActivityThread] Could not stop current execution', { appId, runId: state.runningRunId, error }); setStopError(true) } finally { setStopping(false) } }} className="mt-2 min-h-8 text-xs text-muted-foreground disabled:opacity-50">{t('Stop this execution')}</button>}{stopError && <p role="alert" className="mt-2 text-xs text-destructive">{t('Could not stop this execution. Please try again.')}</p>}</section>}
        <PersonTeamWork appId={appId} />
        <section><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-medium">{t('Recent activity')}</h2><select aria-label={t('Activity source')} value={source} onChange={event => { setSource(event.target.value); setHistorySnapshot(null) }} className="min-h-9 rounded-lg border border-border bg-background px-2 text-xs"><option value="all">{t('All sources')}</option><option value="team">{t('Teams')}</option><option value="automation">{t('Independent executions')}</option><option value="chat">{t('Conversations')}</option><option value="unknown">{t('Unknown source')}</option></select></div>
          {newCount > 0 && <button onClick={() => setHistorySnapshot(null)} className="mb-4 min-h-9 rounded-lg border border-primary/20 px-3 text-xs text-primary">{t('Show {{count}} new updates', { count: newCount })}</button>}
          {!initialLoading && !history.length && <p className="py-5 text-sm text-muted-foreground">{t('No activity to display.')}</p>}
          {history.map(entry => <ActivityEntryCard key={entry.id} entry={entry} appId={appId} />)}
          {hasMore && <button disabled={loading} onClick={async () => { setLoading(true); try { await useAppsStore.getState().loadMoreActivity(appId); setHistorySnapshot(null) } finally { setLoading(false) } }} className="min-h-10 w-full rounded-lg border border-border text-sm disabled:opacity-50">{loading ? t('Loading…') : t('Load more activity')}</button>}
        </section>
      </main>
      <aside className="min-w-0"><section className="rounded-xl border border-border bg-secondary/20 p-4"><h2 className="flex items-center gap-2 text-sm font-medium"><CalendarClock size={16} />{t('Automatic tasks')}</h2><p className="mt-3 text-sm">{paused ? t('Paused') : t('Enabled')}</p><p className="mt-2 text-xs leading-6 text-muted-foreground">{paused ? t('Automatic tasks are paused. Existing requests remain available. You can run once or answer to continue the original work.') : (state?.pendingSoloDecisionCount ?? 0) > 0 ? t('{{count}} independent executions need your answer. New scheduled and event tasks are skipped. You can still run once.', { count: state!.pendingSoloDecisionCount }) : busy ? t('An independent execution is still in progress. New automatic triggers are skipped.') : t('New tasks start when their configured triggers occur.')}</p>{(state?.continuationCount ?? 0) > 0 && <p className="mt-3 flex items-start gap-2 text-xs text-primary"><AlertCircle size={14} className="shrink-0" />{t('{{count}} answered requests are waiting to continue', { count: state!.continuationCount })}</p>}</section><PersonTeams appId={appId} /></aside>
    </div>
  </div>
}
