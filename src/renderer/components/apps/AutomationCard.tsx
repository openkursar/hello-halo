/**
 * AutomationCard
 *
 * Grid card for one digital human in the card wall (AutomationCardWall).
 * Shows persona + live status + latest output at a glance, without opening
 * the detail page, and carries the same corner actions SkillCard/McpCard do
 * so the three walls behave alike.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { RotateCcw, MoreHorizontal, Play, FolderInput, Globe, Trash2, Check } from 'lucide-react'
import type { InstalledApp, AppOverviewEntry } from '../../../shared/apps/app-types'
import { AutomationAvatar } from './AutomationAvatar'
import { Tooltip } from '../ui/Tooltip'
import { AppStatusDot } from './AppStatusDot'
import { SpaceAvatar } from '../space/SpaceAvatar'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { deriveAutomationStatus, automationStatusLabel, automationStatusTextClass, runStatusDotClass, type EffectiveAutomationStatus } from '../../utils/automation-status'
import { formatTimeAgo, formatElapsed } from '../../utils/format-time'

interface AutomationCardProps {
  app: InstalledApp
  overview?: AppOverviewEntry
  /** Resolved name of the space this one lives in, or the "global" label. */
  spaceLabel?: string
  onOpen: () => void
  onOpenEscalation: () => void
}

/** 1s tick, but only while a running card is actually mounted showing elapsed time. */
function useElapsed(startedAtMs?: number): string | null {
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (startedAtMs == null) return
    const id = setInterval(() => forceTick(v => v + 1), 1000)
    return () => clearInterval(id)
  }, [startedAtMs])
  if (startedAtMs == null) return null
  return formatElapsed(Date.now() - startedAtMs)
}

export function AutomationCard({ app, overview, spaceLabel, onOpen, onOpenEscalation }: AutomationCardProps) {
  const { t } = useTranslation()
  const { triggerApp, uninstallApp, reinstallApp, moveAppToSpace } = useAppsStore()
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const spaces = useSpaceStore(s => s.spaces)
  const { showConfirm, DialogComponent } = useConfirmDialog()

  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuView, setMenuView] = useState<'main' | 'move'>('main')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setMenuView('main')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
  const runtimeStatus = overview?.state.status
  const effectiveStatus: EffectiveAutomationStatus = deriveAutomationStatus(app.status, runtimeStatus)

  const isRunning = effectiveStatus === 'running'
  const isQueued = effectiveStatus === 'queued'
  const needsMe = effectiveStatus === 'waiting_user' || effectiveStatus === 'error' || effectiveStatus === 'needs_login'
  const isPaused = effectiveStatus === 'paused'
  const isUninstalled = app.status === 'uninstalled'

  const elapsed = useElapsed(isRunning ? overview?.state.runningAtMs : undefined)
  const lastRunLabel = overview?.state.lastRunAtMs ? formatTimeAgo(overview.state.lastRunAtMs, t) : null

  // What an owner checks at a glance: is it on schedule, and has it been
  // succeeding. Both ship in the overview payload already.
  const nextRunAt = overview?.state.nextRunAtMs
  const cadenceLabel = !isRunning && !isQueued && !needsMe && !isPaused && nextRunAt
    ? t('next {{time}}', { time: new Date(nextRunAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) })
    : null
  const runs = overview?.recentRunStatuses ?? []
  const okRuns = runs.filter(r => r === 'ok').length

  const handleRun = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    setBusy(true)
    await triggerApp(app.id)
    setBusy(false)
  }, [app.id, triggerApp])

  const handleUninstall = useCallback(async () => {
    setMenuOpen(false)
    const confirmed = await showConfirm({
      title: t('Uninstall this digital human?'),
      message: t('You can reinstall it later from the Uninstalled group.'),
      confirmLabel: t('Uninstall'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (confirmed) await uninstallApp(app.id)
  }, [app.id, showConfirm, t, uninstallApp])

  const handleMoveTo = useCallback(async (newSpaceId: string | null) => {
    setMenuOpen(false)
    setMenuView('main')
    await moveAppToSpace(app.id, newSpaceId)
  }, [app.id, moveAppToSpace])

  const allSpaces = [
    ...(haloSpace ? [haloSpace] : []),
    ...spaces.filter(s => !haloSpace || s.id !== haloSpace.id),
  ]

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter') onOpen() }}
      className={`group relative flex flex-col text-left bg-card border rounded-lg p-4 transition-all cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
        ${isUninstalled
          ? 'border-dashed opacity-60 hover:opacity-100'
          : needsMe
            ? 'border-halo-warning/40'
            : isPaused
              ? 'border-border/60 opacity-75 hover:opacity-100 hover:border-border'
              : 'border-border/60 hover:border-border hover:shadow-sm'}`}
    >
      {/* Header row */}
      <div className="flex items-start gap-2.5">
        <div className="flex-shrink-0 rounded-xl overflow-hidden">
          <AutomationAvatar name={name || app.id} size={44} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate leading-tight">{name}</h3>
            {spaceLabel && (
              <Tooltip
                side="bottom"
                className="flex-shrink-0 max-w-[45%]"
                label={app.spaceId
                  ? t('Workspace: {{name}}', { name: spaceLabel })
                  : t('Global — runs outside any workspace')}
              >
                <span className="truncate text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/70">
                  {spaceLabel}
                </span>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1 min-w-0">
            <AppStatusDot status={app.status} runtimeStatus={runtimeStatus} size="sm" />
            <span className={`text-xs truncate ${automationStatusTextClass(effectiveStatus)}`}>
              {automationStatusLabel(effectiveStatus, t)}
            </span>
            {/* The status dot already pulses while running, so the elapsed
                time rides the status it belongs to instead of carrying its
                own spinner in a separate corner. `cadenceLabel` is null in
                exactly these states, so the two never compete for the slot. */}
            {isRunning && elapsed && (
              <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">· {elapsed}</span>
            )}
            {cadenceLabel && (
              <span className="text-xs text-muted-foreground truncate">· {cadenceLabel}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity">
          {isUninstalled && (
            <button
              onClick={e => { e.stopPropagation(); void reinstallApp(app.id) }}
              title={t('Reinstall')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <div ref={menuRef} className="relative">
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
              title={t('More')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div onClick={e => e.stopPropagation()} className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-popover border border-border rounded-lg shadow-lg py-1 text-sm">
                {menuView === 'main' ? (
                  <>
                    {!isUninstalled && (
                      <button onClick={handleRun} disabled={busy || isRunning || isQueued} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors disabled:opacity-40">
                        <Play className="w-3.5 h-3.5 text-muted-foreground" /> {t('Run now')}
                      </button>
                    )}
                    <button onClick={() => setMenuView('move')} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <FolderInput className="w-3.5 h-3.5 text-muted-foreground" /> {t('Move to workspace')}
                    </button>
                    <div className="my-1 border-t border-border/60" />
                    <button onClick={handleUninstall} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-halo-error hover:bg-halo-error/10 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" /> {t('Uninstall')}
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => handleMoveTo(null)} className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                      <span className="flex items-center gap-2"><Globe className="w-[14px] h-[14px] text-muted-foreground" /> {t('Global (all workspaces)')}</span>
                      {app.spaceId === null && <Check className="w-3.5 h-3.5 text-primary" />}
                    </button>
                    {allSpaces.map(s => (
                      <button key={s.id} onClick={() => handleMoveTo(s.id)} className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors">
                        <span className="flex items-center gap-2 min-w-0">
                          <SpaceAvatar space={s} size={14} />
                          <span className="truncate">{s.isTemp ? t('Halo') : s.name}</span>
                        </span>
                        {app.spaceId === s.id && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      {description && (
        <p className="mt-2.5 text-xs text-muted-foreground line-clamp-1">{description}</p>
      )}

      {!isUninstalled && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {runs.length > 0 ? (
            <>
              <div className="flex items-center gap-1">
                {runs.map((status, i) => (
                  <span key={i} className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${runStatusDotClass(status)}`} />
                ))}
              </div>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {t('{{ok}}/{{total}} ok', { ok: okRuns, total: runs.length })}
              </span>
              {lastRunLabel && (
                <span className="text-[11px] text-muted-foreground truncate">· {lastRunLabel}</span>
              )}
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 border border-muted-foreground/40" />
              <span className="text-[11px] text-muted-foreground/70">{t('Never run')}</span>
            </>
          )}
        </div>
      )}

      {/* Needs-me todo bar / latest output — pinned to card bottom via mt-auto;
          min gap from description comes from mt-4 on the spacer below. */}
      {needsMe ? (
        <>
          <div className="flex-1 min-h-4" />
          <div
            onClick={e => { e.stopPropagation(); onOpenEscalation() }}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-halo-warning/[0.08] border border-halo-warning/[0.18] cursor-pointer"
          >
            <p className="flex-1 min-w-0 text-xs text-foreground truncate">
              {effectiveStatus === 'waiting_user' && (overview?.latestSummary?.summary || t('Waiting for your input'))}
              {effectiveStatus === 'error' && (overview?.state.lastError || t('Repeated failures, paused'))}
              {effectiveStatus === 'needs_login' && t('Login expired, needs to sign in again')}
            </p>
            {effectiveStatus === 'error' && (
              <button
                onClick={handleRun}
                disabled={busy}
                className="flex-shrink-0 flex items-center gap-1 px-2 text-[11px] font-medium text-primary hover:bg-primary/10 rounded transition-colors"
              >
                <RotateCcw className="w-3 h-3" /> {t('Retry')}
              </button>
            )}
          </div>
        </>
      ) : overview?.latestSummary?.summary ? (
        <>
          <div className="flex-1 min-h-4" />
          <div className="px-2.5 py-1.5 rounded-md bg-secondary/50">
            <p className="text-xs text-muted-foreground truncate">{overview.latestSummary.summary}</p>
          </div>
        </>
      ) : null}

      {DialogComponent}
    </div>
  )
}
