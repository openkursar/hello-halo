/**
 * AutomationHeader
 *
 * Persona card + tab bar for automation (digital human) apps.
 * Top section: avatar, name, status, last activity summary, and action buttons.
 * Bottom section: tab bar to switch between Activity / Teams / Config views.
 *
 * Conversations with the digital human are not a tab: they live on the main
 * conversation board, next to every other conversation of the workspace. The
 * action row only links there (the "Chat" button).
 *
 * The avatar is generated deterministically from the app name using boring-avatars.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Play, Pause, RefreshCw, Globe, ExternalLink, MessageSquare, MessagesSquare, Activity, Cog, ChevronRight, Share2, Users, MoreVertical, Download, FolderOpen, Trash2, Unplug } from 'lucide-react'
import { AutomationAvatar } from './AutomationAvatar'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { AppStatusDot } from './AppStatusDot'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { formatTimeAgo } from '../../utils/format-time'
import { resolvePermission } from '../../../shared/apps/app-types'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { openDigitalHumanChat } from '../../utils/conversation-navigation'
import { useAppImInstances } from '../../hooks/useAppImInstances'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { ShareCurrentAppDialog } from '../store/ShareCurrentAppDialog'
import { WorkspaceMigrationDialog } from './WorkspaceMigrationDialog'
import type { BrowserLoginEntry } from '../../../shared/apps/spec-types'

interface AutomationHeaderProps {
  appId: string
  /** Space name to display in the header subtitle */
  spaceName?: string
}

// Friendly, human-feeling status labels
function statusLabel(s: string, t: (key: string) => string): string {
  switch (s) {
    case 'running': return t('Working')
    case 'queued': return t('Queued')
    case 'idle': return t('Standing by')
    case 'waiting_user': return t('Waiting for you')
    case 'paused': return t('Automatic tasks paused')
    case 'error': return t('Encountered an issue')
    default: return s
  }
}

export type AutomationTab = 'activity' | 'config' | 'teams' | 'sessions'

export function AutomationHeader({ appId, spaceName }: AutomationHeaderProps) {
  const { t } = useTranslation()
  const { apps, appStates, pauseApp, resumeApp, triggerApp, exportApp, uninstallApp, restartAppAgent } = useAppsStore()
  const { openAppConfig, openActivityThread, openAppTeams, openAppSessions, selectApp, detailView } = useAppsPageStore()
  const { showConfirm, DialogComponent } = useConfirmDialog()
  // Presence of bound IM bots decides whether the IM sessions tab exists.
  const { instances: imInstances } = useAppImInstances(appId)
  const app = apps.find(a => a.id === appId)
  const runtimeState = appStates[appId]

  const [action, setAction] = useState(false)
  const [actionError, setActionError] = useState(false)
  const perform = async (operation: () => Promise<boolean>) => {
    if (action) return
    setAction(true); setActionError(false)
    try { setActionError(!await operation()) } finally { setAction(false) }
  }

  // Browser popover state
  const [showBrowserPopover, setShowBrowserPopover] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Share dialog state
  const [showShareDialog, setShowShareDialog] = useState(false)

  // Workspace migration dialog state
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false)

  // "More" menu state (lifecycle actions that don't merit a header button)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  // Close popover on outside click
  useEffect(() => {
    if (!showBrowserPopover) return
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowBrowserPopover(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showBrowserPopover])

  useEffect(() => {
    if (!showMoreMenu) return
    function handleClickOutside(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showMoreMenu])

  const handleOpenBrowser = useCallback((url: string, label: string) => {
    setShowBrowserPopover(false)
    api.openLoginWindow(url, label)
  }, [])

  // Derive current tab from detailView
  const currentTab: AutomationTab = useMemo(() => {
    if (detailView?.type === 'app-config') return 'config'
    if (detailView?.type === 'app-teams') return 'teams'
    if (detailView?.type === 'app-sessions' || detailView?.type === 'bot-sessions') return 'sessions'
    return 'activity'
  }, [detailView])

  if (!app) return null

  const { name, description, browser_login } = resolveSpecI18n(app.spec, getCurrentLanguage())
  const status = app.status
  const runtimeStatus = runtimeState?.status
  const effectiveStatus = runtimeStatus ?? (status === 'active' ? 'idle' : status)
  const isAutomation = app.spec.type === 'automation'

  const isPaused = runtimeState?.automaticEnabled === false || status === 'paused'
  const isRunning = effectiveStatus === 'running'
  const isQueued = effectiveStatus === 'queued'

  // Browser button visibility
  const hasBrowserLogin = browser_login && browser_login.length > 0
  const hasAiBrowser = resolvePermission(app, 'ai-browser')
  const showBrowserButton = hasBrowserLogin || hasAiBrowser

  // Next run info
  let nextRunLabel: string | null = null
  if (isAutomation && runtimeState?.nextRunAtMs) {
    const diff = runtimeState.nextRunAtMs - Date.now()
    if (diff > 0) {
      const mins = Math.floor(diff / 60_000)
      const hrs = Math.floor(mins / 60)
      nextRunLabel = hrs > 0
        ? t('Next run in {{count}}h', { count: hrs })
        : t('Next run in {{count}}m', { count: mins })
    }
  }

  // Frequency label — the configured schedule, not the spec's suggested
  // default, so this reads the same value the scheduler runs on.
  const sub = app.spec.type === 'automation' ? app.spec.subscriptions?.[0] : undefined
  let freqLabel: string | null = null
  if (sub) {
    freqLabel = sub.source.type === 'schedule'
      ? sub.source.config.every ?? sub.source.config.cron ?? null
      : null
    freqLabel ??= sub.frequency?.default ?? null
  }

  // Last activity summary from runtime state
  const lastRunLabel = runtimeState?.lastRunAtMs
    ? formatTimeAgo(runtimeState.lastRunAtMs, t)
    : null

  // Tab click handlers
  const handleTabActivity = () => openActivityThread(appId)
  const handleTabConfig = () => openAppConfig(appId)

  // Talking to a digital human happens on the main conversation board, which
  // owns the conversation list and the recipient picker; this button is the
  // shortcut into it, and only a digital human bound to a workspace has one.
  const handleSendMessage = () => perform(async () => openDigitalHumanChat(appId, app.spaceId ?? null))

  const handleUninstall = async () => {
    setShowMoreMenu(false)
    const confirmed = await showConfirm({
      title: t('Uninstall this digital human?'),
      message: t('Its work history is kept. You can reinstall it later from the removed list in the directory.'),
      confirmLabel: t('Uninstall'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (!confirmed) return
    await perform(async () => {
      const ok = await uninstallApp(appId)
      // Route to the uninstalled detail so the header's live controls don't
      // linger on an app that can no longer run.
      if (ok) selectApp(appId, 'uninstalled')
      return ok
    })
  }

  const handleClearMemory = async () => {
    setShowMoreMenu(false)
    const confirmed = await showConfirm({
      title: t('Clear this digital human\'s memory?'),
      message: t('Memory is the internal runtime state (memory.md and run history). Clearing it does not affect files in the space.'),
      confirmLabel: t('Clear Memory'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (!confirmed) return
    await perform(async () => {
      const res = await api.appClearMemory(appId)
      if (!res.success) console.error('[AutomationHeader] appClearMemory failed:', res.error)
      return res.success
    })
  }

  const tabs: { key: AutomationTab; label: string; icon: typeof MessageSquare; onClick: () => void }[] = [
    { key: 'activity', label: t('Work activity'), icon: Activity, onClick: handleTabActivity },
    // Only a digital human with a bound bot carries external traffic worth a tab.
    ...(imInstances.length > 0 && app.spaceId
      ? [{ key: 'sessions' as const, label: t('IM sessions'), icon: MessagesSquare, onClick: () => openAppSessions(appId) }]
      : []),
    { key: 'teams', label: t('Participating teams'), icon: Users, onClick: () => openAppTeams(appId) },
    { key: 'config', label: t('Capabilities and settings'), icon: Cog, onClick: handleTabConfig },
  ]

  return (
    <div className="flex-shrink-0">
      {/* ── Persona Card ── */}
      <div className="flex flex-wrap items-start gap-3 px-6 pt-5 pb-4 sm:px-10">
        {/* Avatar */}
        <div className="flex-shrink-0 rounded-xl overflow-hidden">
          <AutomationAvatar name={name || appId} size={44} />
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground truncate leading-tight">{name}</h2>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <AppStatusDot status={status} runtimeStatus={runtimeStatus} size="sm" />
            <span className="text-xs text-muted-foreground">
              {statusLabel(effectiveStatus, t)}
              {freqLabel && <span className="mx-1">·</span>}
              {freqLabel && <span>{freqLabel}</span>}
            </span>
            {(runtimeState?.pendingDecisionCount ?? 0) > 0 && <button onClick={handleTabActivity} className="min-h-7 rounded-md bg-halo-warning/10 px-2 text-xs text-halo-warning">{t('{{count}} waiting for you', { count: runtimeState!.pendingDecisionCount })}</button>}
            {isPaused && (isRunning || isQueued) && <span className="text-xs text-muted-foreground">{t('Automatic tasks paused')}</span>}
          </div>
          {(nextRunLabel || lastRunLabel || (spaceName && app.spaceId)) && (
            <p className="text-[11px] text-muted-foreground/60 mt-0.5 truncate flex items-center gap-0">
              {lastRunLabel && <span>{t('Last run')} {lastRunLabel}</span>}
              {lastRunLabel && nextRunLabel && <span className="mx-1">·</span>}
              {nextRunLabel && <span>{nextRunLabel}</span>}
              {spaceName && app.spaceId && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    const spaceStore = useSpaceStore.getState()
                    const target = spaceStore.spaces.find(s => s.id === app.spaceId) ?? (spaceStore.haloSpace?.id === app.spaceId ? spaceStore.haloSpace : null)
                    if (target) {
                      spaceStore.setCurrentSpace(target)
                      useAppStore.getState().navigate('space')
                    } else {
                      console.warn('[AutomationHeader] Workspace navigation unavailable', { appId, spaceId: app.spaceId })
                      setActionError(true)
                    }
                  }}
                  className="inline-flex items-center gap-1 ml-1.5 px-1.5 py-0.5 rounded-sm bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-primary transition-colors text-[11px] leading-tight"
                  title={t('Go to workspace')}
                >
                  <span className="truncate max-w-[120px]">{t('Workspace')}: {spaceName}</span>
                  <ChevronRight className="w-3 h-3 flex-shrink-0 opacity-60" />
                </button>
              )}
            </p>
          )}
        </div>

        {/* Action buttons */}
        {isAutomation && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Leads the row: talking to the person is the most common action,
                everything after it is app-lifecycle management. */}
            {app.spaceId && (
              <button onClick={() => void handleSendMessage()} disabled={action}
                title={t('Opens the conversation with this digital human in the workspace chat')}
                className="flex min-h-9 items-center gap-1.5 rounded-lg bg-primary border border-primary px-3.5 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
                <MessageSquare size={14} />{t('Chat')}
              </button>
            )}

            <button onClick={() => void perform(() => triggerApp(appId))} disabled={action || isRunning || isQueued}
              title={isQueued ? t('An independent execution is already queued') : isRunning ? t('An independent execution is already running') : t('Start a new independent execution')}
              className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs hover:bg-secondary disabled:opacity-50">
              <Play size={14} />{isQueued ? t('Queued') : isRunning ? t('Working') : t('Run now')}
            </button>
            <button onClick={() => void perform(() => isPaused ? resumeApp(appId) : pauseApp(appId))} disabled={action}
              aria-pressed={!isPaused} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs hover:bg-secondary disabled:opacity-50">
              {isPaused ? <RefreshCw size={14} /> : <Pause size={14} />}{isPaused ? t('Enable automatic tasks') : t('Pause automatic tasks')}
            </button>

            {/* Browser */}
            {showBrowserButton && (
              <div ref={popoverRef} className="relative">
                <button
                  onClick={() => setShowBrowserPopover(prev => !prev)}
                  title={t('Browser')}
                  aria-label={t('Browser')} aria-expanded={showBrowserPopover}
                  className="min-h-9 min-w-9 flex items-center justify-center p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
                >
                  <Globe className="w-3.5 h-3.5" />
                </button>
                {showBrowserPopover && (
                  <BrowserLoginPopover
                    entries={browser_login ?? []}
                    onOpen={handleOpenBrowser}
                    onOpenCustomUrl={(url) => handleOpenBrowser(url, t('Browser'))}
                    t={t}
                  />
                )}
              </div>
            )}

            {/* More: lifecycle actions that don't merit their own header button */}
            <div ref={moreMenuRef} className="relative">
              <button
                onClick={() => setShowMoreMenu(prev => !prev)}
                title={t('More')}
                aria-label={t('More')} aria-expanded={showMoreMenu}
                className="min-h-9 min-w-9 flex items-center justify-center p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
              {showMoreMenu && (
                <div className="absolute right-0 top-full mt-1 z-50 min-w-[210px] max-w-[calc(100vw-2rem)] bg-popover border border-border rounded-lg shadow-lg overflow-hidden py-1">
                  {/* Non-destructive: reloads prompt/config across chat channels,
                      conversation history preserved. */}
                  <button
                    onClick={() => { setShowMoreMenu(false); void perform(() => restartAppAgent(appId)) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />{t('Restart agent')}
                  </button>
                  <button
                    onClick={() => { setShowMoreMenu(false); setShowShareDialog(true) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Share2 className="w-3.5 h-3.5 text-muted-foreground" />{t('Share')}
                  </button>
                  <button
                    onClick={() => { setShowMoreMenu(false); void perform(() => exportApp(appId)) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5 text-muted-foreground" />{t('Export configuration')}
                  </button>
                  <button
                    onClick={() => { setShowMoreMenu(false); setShowWorkspaceDialog(true) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />{t('Move to another workspace')}
                  </button>
                  <div className="my-1 border-t border-border" />
                  <button
                    onClick={() => void handleClearMemory()}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-halo-warning hover:bg-halo-warning/10 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />{t('Clear Memory')}
                  </button>
                  <button
                    onClick={() => void handleUninstall()}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-halo-error hover:bg-halo-error/10 transition-colors"
                  >
                    <Unplug className="w-3.5 h-3.5" />{t('Uninstall')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {actionError && <p role="alert" className="px-6 pb-3 text-sm text-destructive sm:px-10">{t('Could not apply this action. Please try again.')}</p>}
      {DialogComponent}
      {showShareDialog && (
        <ShareCurrentAppDialog
          appId={appId}
          onClose={() => setShowShareDialog(false)}
        />
      )}
      {showWorkspaceDialog && (
        <WorkspaceMigrationDialog
          appId={appId}
          spaceId={app.spaceId}
          onClose={() => setShowWorkspaceDialog(false)}
        />
      )}

      {/* ── Tab Bar ── */}
      {isAutomation && (
        // Rule sits under the tabs, inset like the header; `min-w-full w-max`
        // keeps it under the whole strip once the tabs scroll horizontally.
        <div className="overflow-x-auto px-6 sm:px-10">
          <div className="flex min-w-full w-max items-center gap-0.5 border-b border-border">
          {tabs.map(tab => {
            const Icon = tab.icon
            const isActive = currentTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={tab.onClick}
                aria-pressed={isActive}
                className={`flex shrink-0 items-center gap-1.5 px-3 py-3 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  isActive
                    ? 'text-foreground border-foreground'
                    : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────
// Browser Login Popover
// ──────────────────────────────────────────────

interface BrowserLoginPopoverProps {
  entries: BrowserLoginEntry[]
  onOpen: (url: string, label: string) => void
  onOpenCustomUrl: (url: string) => void
  t: (s: string, opts?: Record<string, unknown>) => string
}

function BrowserLoginPopover({ entries, onOpen, onOpenCustomUrl, t }: BrowserLoginPopoverProps) {
  const [customUrl, setCustomUrl] = useState('')

  const handleOpenCustom = () => {
    const trimmed = customUrl.trim()
    if (!trimmed) return
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    onOpenCustomUrl(url)
    setCustomUrl('')
  }

  return (
    <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] max-w-[calc(100vw-2rem)] sm:max-w-[300px] bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-foreground">{t('Browser')}</span>
      </div>

      {/* Preset login entries */}
      {entries.length > 0 && (
        <div className="py-1">
          {entries.map(entry => (
            <button
              key={entry.url}
              onClick={() => onOpen(entry.url, entry.label)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/60 transition-colors group"
            >
              <span className="text-sm text-foreground truncate">{entry.label}</span>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
            </button>
          ))}
        </div>
      )}

      {/* Custom URL input */}
      <div className={`px-3 py-2 ${entries.length > 0 ? 'border-t border-border' : ''}`}>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleOpenCustom() }}
            aria-label={t('Browser URL')}
            placeholder={t('Enter URL')}
            className="flex-1 min-w-0 bg-muted border border-border rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <button
            onClick={handleOpenCustom}
            disabled={!customUrl.trim()}
            className="flex-shrink-0 p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('Open')}
            aria-label={t('Open URL')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
