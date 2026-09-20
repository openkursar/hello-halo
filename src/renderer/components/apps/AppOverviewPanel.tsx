/**
 * AppOverviewPanel
 *
 * Default landing tab for a digital human's detail page. Answers "what does
 * it need from me, how is it doing, and what has it been producing" in one
 * screen, without requiring a trip into Activity/Settings. Every block is
 * pure aggregation over data owned elsewhere — no logic is duplicated from
 * the Activity thread or the Settings panel.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Bot, Bell, ChevronRight, Cog, Globe, Loader2, RotateCcw, Server, Puzzle, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { AppSpaceCell } from './AppSpaceCell'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { automationStatusLabel, automationStatusTextClass, deriveAutomationStatus, runStatusDotClass } from '../../utils/automation-status'
import { AppStatusDot } from './AppStatusDot'
import { formatTimeAgo, formatElapsed } from '../../utils/format-time'
import { selectLatestOutput } from '../../utils/activity'
import { deriveMcpHealth } from '../../utils/mcpStatus'
import { resolvePermission } from '../../../shared/apps/app-types'
import { findMissingRequiredConfig } from '../../../shared/apps/config-validation'
import { EscalationCard } from './EscalationCard'
import { ActivityEntryCard } from './ActivityEntryCard'
import { AppExternalChannelsCard } from './AppExternalChannelsCard'
import { api } from '../../api'
import type { AutomationRunWithSummary } from '../../../shared/apps/app-types'

interface AppOverviewPanelProps {
  appId: string
}

function formatRunTimestamp(ts: number): string {
  const d = new Date(ts)
  const isToday = new Date().toDateString() === d.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time
  const date = d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
  return `${date} ${time}`
}

export function AppOverviewPanel({ appId }: AppOverviewPanelProps) {
  const { t } = useTranslation()
  const { apps, appStates, activityEntries, loadActivity, loadAppState } = useAppsStore()
  const mcpStatus = useAppStore(s => s.mcpStatus)
  const allSpaces = useSpaceStore(s => s.spaces)
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const openActivityThread = useAppsPageStore(s => s.openActivityThread)
  const openAppConfig = useAppsPageStore(s => s.openAppConfig)
  const openAppConfigAt = useAppsPageStore(s => s.openAppConfigAt)
  const openSessionDetail = useAppsPageStore(s => s.openSessionDetail)
  const triggerApp = useAppsStore(s => s.triggerApp)
  const moveAppToSpace = useAppsStore(s => s.moveAppToSpace)

  const [runs, setRuns] = useState<AutomationRunWithSummary[]>([])
  const [, forceTick] = useState(0)

  const app = apps.find(a => a.id === appId)
  const runtimeState = appStates[appId]
  const entries = activityEntries[appId] ?? []

  useEffect(() => {
    loadActivity(appId, { limit: 20 })
    loadAppState(appId)
  }, [appId, loadActivity, loadAppState])

  // Just enough for a reliability glance (dot strip + a couple of recent
  // summaries) — the full paginated history lives in the Activity tab, not
  // duplicated here.
  useEffect(() => {
    let cancelled = false
    api.appGetRuns(appId, { limit: 7 }).then(res => {
      if (!cancelled && res.success && Array.isArray(res.data)) {
        setRuns(res.data as AutomationRunWithSummary[])
      }
    })
    return () => { cancelled = true }
  }, [appId])

  // 1s tick while a run is live, so the running row's elapsed time counts up.
  useEffect(() => {
    if (runtimeState?.status !== 'running') return
    const id = setInterval(() => forceTick(v => v + 1), 1000)
    return () => clearInterval(id)
  }, [runtimeState?.status])

  if (!app) return null

  const resolvedSpec = resolveSpecI18n(app.spec, getCurrentLanguage())
  const effectiveStatus = deriveAutomationStatus(app.status, runtimeState?.status)
  const needsMe = effectiveStatus === 'waiting_user' || effectiveStatus === 'error' || effectiveStatus === 'needs_login'
  const pendingEscalation = app.pendingEscalationId ? entries.find(e => e.id === app.pendingEscalationId) : undefined
  const latestOutput = useMemo(() => selectLatestOutput(entries), [entries])

  // Trigger frequency (same resolution AutomationHeader/AutomationCard use)
  const sub = app.spec.type === 'automation' ? app.spec.subscriptions?.[0] : undefined
  let freqLabel = t('Manual / IM trigger')
  // The spec's schedule is the only interval the scheduler reads; there is no
  // separate user override to fold in (see manager.updateFrequency).
  if (sub) {
    if (sub.frequency?.default) freqLabel = sub.frequency.default
    else if (sub.source.type === 'schedule') freqLabel = sub.source.config.every ?? sub.source.config.cron ?? freqLabel
  }
  const extraSubsCount = app.spec.type === 'automation' ? (app.spec.subscriptions?.length ?? 0) - 1 : 0

  // Capability chips (block 5)
  const declaredMcps = app.spec.type === 'automation' ? app.spec.requires?.mcps ?? [] : []
  const declaredSkills = app.spec.type === 'automation' ? app.spec.requires?.skills ?? [] : []
  const failingMcps = declaredMcps.filter(dep => {
    const mcpApp = apps.find(a => a.specId === dep.id && a.spec.type === 'mcp') ?? null
    const sdkEntry = mcpStatus.find(s => s.name === dep.id)
    const health = deriveMcpHealth(mcpApp, sdkEntry)
    return health === 'failed' || health === 'needs-login'
  })
  const hasFailingMcp = failingMcps.length > 0
  const notifyChannels = app.spec.type === 'automation' ? app.spec.output?.notify?.channels ?? [] : []
  const notificationLevel = app.userOverrides?.notificationLevel ?? 'important'
  const usesCustomModel = !!(app.userOverrides?.modelSourceId || app.userOverrides?.modelId)
  const browserLogin = resolvedSpec.browser_login ?? []
  const missingConfig = findMissingRequiredConfig(resolvedSpec.config_schema, app.userConfig)
  const latestRun = runs[0]

  // Space resolution for the owning-space cell
  const space = app.spaceId
    ? (allSpaces.find(s => s.id === app.spaceId) ?? (haloSpace?.id === app.spaceId ? haloSpace : undefined))
    : undefined
  const spaceLabel = app.spaceId
    ? (allSpaces.find(s => s.id === app.spaceId)?.name ?? haloSpace?.name ?? app.spaceId)
    : t('Global')
  const [spaceMoving, setSpaceMoving] = useState(false)

  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 sm:px-10 py-4 pb-6 space-y-6">
      {/* Block 1: needs my attention.
          Missing required config is not a runtime status — a healthy, running
          app can still be missing it — so it renders as its own alert rather
          than joining the status chain below. */}
      {missingConfig.length > 0 && (
        <div className="rounded-lg border border-halo-warning/[0.18] bg-halo-warning/[0.08] p-3.5 space-y-2.5">
          <div className="flex items-start gap-2">
            <SlidersHorizontal className="w-4 h-4 text-halo-warning mt-0.5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">
                {t('{{count}} required settings are empty', { count: missingConfig.length })}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('It keeps running and reports success, but works without these values: {{fields}}', {
                  fields: missingConfig.map(def => def.label).join(' · '),
                })}
              </p>
            </div>
          </div>
          <button
            onClick={() => openAppConfigAt(appId, 'settings-group-configuration')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" /> {t('Fill them in')}
          </button>
        </div>
      )}

      {needsMe && (
        <div className="rounded-lg border border-halo-warning/[0.18] bg-halo-warning/[0.08] p-3.5">
          {effectiveStatus === 'waiting_user' && pendingEscalation ? (
            <EscalationCard entry={pendingEscalation} appId={appId} />
          ) : effectiveStatus === 'error' ? (
            <div className="space-y-2.5">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-halo-error mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">{runtimeState?.lastError || t('Repeated failures, paused')}</p>
                  {typeof runtimeState?.consecutiveErrors === 'number' && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('{{count}} consecutive failures', { count: runtimeState.consecutiveErrors })}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => triggerApp(appId)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> {t('Retry now')}
                </button>
                <button
                  onClick={() => openActivityThread(appId)}
                  className="text-xs text-primary hover:underline"
                >
                  {t('View failed run')}
                </button>
              </div>
            </div>
          ) : effectiveStatus === 'needs_login' ? (
            <div className="space-y-2.5">
              <div className="flex items-start gap-2">
                <Globe className="w-4 h-4 text-halo-warning mt-0.5 flex-shrink-0" />
                <p className="text-sm text-foreground">{t('Login expired, needs to sign in again')}</p>
              </div>
              {browserLogin.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {browserLogin.map(entry => (
                    <button
                      key={entry.url}
                      onClick={() => api.openLoginWindow(entry.url, entry.label)}
                      className="px-2.5 py-1 text-xs font-medium rounded-md bg-halo-warning text-white hover:opacity-90 transition-opacity"
                    >
                      {t('Open {{site}}', { site: entry.label })}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* Block 2: status grid */}
      <div>
        {/* `items-stretch justify-start` on every cell: a stretched <button>
            centers its content vertically per the UA stylesheet, so the taller
            cells would otherwise push their neighbours' labels off the top
            line. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
          <button onClick={() => openActivityThread(appId)} className="flex flex-col items-stretch justify-start text-left bg-card border border-border/60 rounded-lg px-3.5 py-3 hover:border-border hover:shadow-sm transition-all cursor-pointer">
            <div className="text-[11px] text-subtle-foreground mb-[5px]">{t('Status')}</div>
            <div className="text-[13px] font-medium flex items-center gap-1.5">
              <AppStatusDot status={app.status} runtimeStatus={runtimeState?.status} />
              <span className={automationStatusTextClass(effectiveStatus)}>{automationStatusLabel(effectiveStatus, t)}</span>
              {effectiveStatus === 'running' && runtimeState?.runningAtMs && (
                <span className="text-primary tabular-nums text-xs flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {formatElapsed(Date.now() - runtimeState.runningAtMs)}
                </span>
              )}
            </div>
          </button>
          <button onClick={() => openAppConfigAt(appId, 'settings-group-trigger')} className="flex flex-col items-stretch justify-start text-left bg-card border border-border/60 rounded-lg px-3.5 py-3 hover:border-border hover:shadow-sm transition-all cursor-pointer">
            <div className="text-[11px] text-subtle-foreground mb-[5px]">{t('Trigger')}</div>
            <div className="text-[13px] font-medium truncate">
              {freqLabel}{extraSubsCount > 0 && <span className="text-muted-foreground"> {t('+{{count}} more', { count: extraSubsCount })}</span>}
            </div>
          </button>
          <AppSpaceCell
            spaceId={app.spaceId}
            spaceLabel={spaceLabel}
            space={space}
            caption={app.spaceId === null
              ? t('Runs outside any workspace')
              : t("Runs in this workspace's working directory")}
            menuTitle={t('Move this digital human to…')}
            moving={spaceMoving}
            onMove={async (newSpaceId) => {
              setSpaceMoving(true)
              try { await moveAppToSpace(appId, newSpaceId) }
              finally { setSpaceMoving(false) }
            }}
          />
          <button onClick={() => openActivityThread(appId)} className="flex flex-col items-stretch justify-start text-left bg-card border border-border/60 rounded-lg px-3.5 py-3 hover:border-border hover:shadow-sm transition-all cursor-pointer">
            <div className="text-[11px] text-subtle-foreground mb-[5px]">{t('Last run')}</div>
            <div className="text-[13px] font-medium flex items-center gap-1.5">
              {runtimeState?.lastRunAtMs ? formatTimeAgo(runtimeState.lastRunAtMs, t) : '—'}
              {runtimeState?.lastStatus && (
                <span className={`w-1.5 h-1.5 rounded-full ${runtimeState.lastStatus === 'ok' ? 'bg-green-500' : runtimeState.lastStatus === 'error' ? 'bg-red-500' : 'bg-muted-foreground/40'}`} />
              )}
            </div>
          </button>
        </div>
      </div>

      {/* Block 3: latest output — one full entry, not a truncated list, so it
          doesn't need its own "view all" exit (Recent runs below already
          links to Activity). */}
      {latestOutput && (
        <div>
          <h3 className="text-[13px] font-semibold text-foreground mb-2.5">{t('Latest output')}</h3>
          <div className="bg-card border border-border/60 rounded-lg p-3.5">
            <ActivityEntryCard entry={latestOutput} appId={appId} isLast />
          </div>
        </div>
      )}

      {/* Block 4: reliability — an aggregate, not a second copy of the feed.
          Listing the latest runs here made this a mini Activity tab; the
          success rate plus the newest outcome answers "can I trust it" without
          reproducing the log. */}
      {runs.length > 0 && (
        <div>
          <h3 className="text-[13px] font-semibold text-foreground mb-2.5">{t('Reliability')}</h3>

          <div className="rounded-[10px] border border-border/60 bg-card px-3.5 py-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[15px] font-semibold text-foreground tabular-nums">
                {Math.round((runs.filter(r => r.status === 'ok').length / runs.length) * 100)}%
              </span>
              <span className="text-xs text-muted-foreground">
                {t('succeeded in the last {{count}} runs', { count: runs.length })}
              </span>
              <button
                onClick={() => openActivityThread(appId)}
                className="ml-auto flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              >
                {t('All runs')}
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* A single dot carries no trend and just repeats the Latest row
                below it. */}
            {runs.length > 1 && (
              <div className="flex items-center gap-1.5 mt-2.5">
                {[...runs].reverse().map(run => (
                  <span key={run.runId} className={`w-2 h-2 rounded-full flex-shrink-0 ${runStatusDotClass(run.status)}`} title={formatRunTimestamp(run.startedAt)} />
                ))}
              </div>
            )}

            {latestRun && (
              <button
                onClick={() => latestRun.sessionKey && openSessionDetail(appId, latestRun.runId, latestRun.sessionKey)}
                disabled={!latestRun.sessionKey}
                className="w-full flex items-center gap-2 mt-2.5 pt-2.5 border-t border-border/60 text-left disabled:cursor-default"
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${runStatusDotClass(latestRun.status)}`} />
                <span className="text-[11px] text-subtle-foreground flex-shrink-0">{t('Latest')}</span>
                <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                  {latestRun.status === 'error' ? (latestRun.errorMessage ?? latestRun.summary ?? '') : (latestRun.summary ?? '')}
                </span>
                <span className="text-[11px] text-muted-foreground font-mono tabular-nums flex-shrink-0">
                  {formatRunTimestamp(latestRun.startedAt)}
                </span>
                {latestRun.sessionKey && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Block 5: capability summary */}
      <div>
        <h3 className="text-[13px] font-semibold text-foreground mb-2.5">{t('Capabilities')}</h3>
        <div className="flex flex-wrap gap-1.5">
          {(app.spec.permissions ?? []).length > 0 && (
            <Chip icon={Sparkles} label={(app.spec.permissions ?? []).join(' · ')} onClick={() => openAppConfigAt(appId, 'settings-group-model-capabilities')} />
          )}
          {declaredMcps.length > 0 && (
            <Chip
              icon={Server}
              label={hasFailingMcp
                ? t('MCP {{names}} unreachable', { names: failingMcps.map(d => d.id).join(' · ') })
                : `${t('MCP')} ${declaredMcps.map(d => d.id).join(' · ')}`}
              alert={hasFailingMcp}
              onClick={() => openAppConfigAt(appId, 'settings-group-tools')}
            />
          )}
          {declaredSkills.length > 0 && (
            <Chip icon={Puzzle} label={`${t('Skill')} ${declaredSkills.length}`} onClick={() => openAppConfigAt(appId, 'settings-group-tools')} />
          )}
          {(notifyChannels.length > 0 || notificationLevel !== 'important') && (
            <Chip
              icon={Bell}
              label={`${t('Notify')} ${notificationLevel === 'all' ? t('All') : notificationLevel === 'none' ? t('None') : t('Important')}${notifyChannels.length ? ` · ${notifyChannels.join(' · ')}` : ''}`}
              onClick={() => openAppConfigAt(appId, 'settings-group-notifications')}
            />
          )}
          {usesCustomModel && (
            <Chip icon={Bot} label={t('Custom model')} onClick={() => openAppConfigAt(appId, 'settings-group-model-capabilities')} />
          )}
          {browserLogin.length > 0 && (
            <Chip
              icon={Globe}
              label={t('{{count}} login sites', { count: browserLogin.length })}
              alert={effectiveStatus === 'needs_login'}
              onClick={() => openAppConfigAt(appId, 'settings-group-tools')}
            />
          )}
          {declaredMcps.length === 0 && declaredSkills.length === 0 && (app.spec.permissions ?? []).length === 0 && !usesCustomModel && browserLogin.length === 0 && (
            <button onClick={() => openAppConfig(appId)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Cog className="w-3.5 h-3.5" /> {t('Open Settings')}
            </button>
          )}
        </div>
      </div>

      {/* Bound bots / external channels */}
      <AppExternalChannelsCard appId={appId} spaceId={app.spaceId} />
    </div>
  )
}

function Chip({ icon: Icon, label, alert, onClick }: { icon: typeof Bot; label: string; alert?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-full border transition-colors
        ${alert ? 'border-halo-error/40 bg-halo-error/[0.08] text-halo-error' : 'border-border/60 bg-card text-muted-foreground hover:text-foreground hover:border-border'}`}
    >
      <Icon className="w-3 h-3" />
      <span className="truncate max-w-[220px]">{label}</span>
      {alert && <span className="w-1.5 h-1.5 rounded-full bg-halo-error flex-shrink-0" />}
    </button>
  )
}

