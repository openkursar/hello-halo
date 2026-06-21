/**
 * AutomationHeader
 *
 * Persona card + tab bar for automation (digital human) apps.
 * Top section: avatar, name, status, last activity summary, and action buttons.
 * Bottom section: tab bar to switch between Chat / Activity / Config views.
 *
 * The avatar is generated deterministically from the app name using boring-avatars.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Play, Pause, RotateCcw, RefreshCw, Globe, ExternalLink, MessageSquare, Activity, Cog, ChevronRight, Share2 } from 'lucide-react'
import Avatar from 'boring-avatars'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { AppStatusDot } from './AppStatusDot'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { resolvePermission } from '../../../shared/apps/app-types'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { ShareCurrentAppDialog } from '../store/ShareCurrentAppDialog'
import type { BrowserLoginEntry } from '../../../shared/apps/spec-types'

// Brand-aligned palette for boring-avatars
const AVATAR_COLORS = ['#84B9EF', '#6C8EBF', '#3D5A80', '#98C1D9', '#E0FBFC']

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
    case 'paused': return t('Standing by')
    case 'error': return t('Encountered an issue')
    default: return s
  }
}

export type AutomationTab = 'chat' | 'activity' | 'config'

export function AutomationHeader({ appId, spaceName }: AutomationHeaderProps) {
  const { t } = useTranslation()
  const { apps, appStates, pauseApp, resumeApp, triggerApp } = useAppsStore()
  const { openAppConfig, openAppChat, openActivityThread, detailView } = useAppsPageStore()
  const app = apps.find(a => a.id === appId)
  const runtimeState = appStates[appId]

  // Browser popover state
  const [showBrowserPopover, setShowBrowserPopover] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Share dialog state
  const [showShareDialog, setShowShareDialog] = useState(false)

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

  const handleOpenBrowser = useCallback((url: string, label: string) => {
    setShowBrowserPopover(false)
    api.openLoginWindow(url, label)
  }, [])

  // Derive current tab from detailView
  const currentTab: AutomationTab = useMemo(() => {
    if (detailView?.type === 'app-chat') return 'chat'
    if (detailView?.type === 'app-config') return 'config'
    return 'activity'
  }, [detailView])

  if (!app) return null

  const { name, browser_login } = resolveSpecI18n(app.spec, getCurrentLanguage())
  const status = app.status
  const runtimeStatus = runtimeState?.status
  const effectiveStatus = runtimeStatus ?? (status === 'active' ? 'idle' : status)
  const isAutomation = app.spec.type === 'automation'

  const isWaiting = status === 'waiting_user'
  const isPaused = status === 'paused'
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

  // Frequency label
  const sub = app.spec.type === 'automation' ? app.spec.subscriptions?.[0] : undefined
  let freqLabel: string | null = null
  if (sub) {
    const subId = sub.id ?? '0'
    const userOverride = app.userOverrides?.frequency?.[subId]
    if (userOverride) {
      freqLabel = userOverride
    } else if (sub.frequency?.default) {
      freqLabel = sub.frequency.default
    } else if (sub.source.type === 'schedule') {
      freqLabel = sub.source.config.every ?? sub.source.config.cron ?? null
    }
  }

  // Last activity summary from runtime state
  const lastRunLabel = runtimeState?.lastRunAtMs
    ? formatTimeAgo(runtimeState.lastRunAtMs, t)
    : null

  // Tab click handlers
  const handleTabChat = () => {
    if (app.spaceId) {
      openAppChat(appId, app.spaceId)
    }
  }
  const handleTabActivity = () => openActivityThread(appId)
  const handleTabConfig = () => openAppConfig(appId)

  const tabs: { key: AutomationTab; label: string; icon: typeof MessageSquare; onClick: () => void }[] = [
    { key: 'chat', label: t('Chat'), icon: MessageSquare, onClick: handleTabChat },
    { key: 'activity', label: t('Activity'), icon: Activity, onClick: handleTabActivity },
    { key: 'config', label: t('Settings'), icon: Cog, onClick: handleTabConfig },
  ]

  return (
    <div className="flex-shrink-0 border-b border-border">
      {/* ── Persona Card ── */}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        {/* Avatar */}
        <div className="flex-shrink-0 rounded-xl overflow-hidden">
          <Avatar
            size={44}
            name={name || appId}
            variant="beam"
            colors={AVATAR_COLORS}
          />
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground truncate leading-tight">{name}</h2>
          <div className="flex items-center gap-1.5 mt-0.5">
            <AppStatusDot status={status} runtimeStatus={runtimeStatus} size="sm" />
            <span className="text-xs text-muted-foreground">
              {statusLabel(effectiveStatus, t)}
              {freqLabel && <span className="mx-1">·</span>}
              {freqLabel && <span>{freqLabel}</span>}
            </span>
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
                    const target = spaceStore.spaces.find(s => s.id === app.spaceId) ?? spaceStore.haloSpace
                    if (target) {
                      spaceStore.setCurrentSpace(target)
                      useAppStore.getState().setView('space')
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
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {/* Trigger now (also available when paused — backend auto-resumes) */}
            {!isWaiting && (
              <button
                onClick={() => triggerApp(appId)}
                disabled={isRunning || isQueued}
                title={isQueued ? t('Queued — waiting for a run slot') : isPaused ? t('Resume and run now') : t('Run now')}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors disabled:opacity-40"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Retry */}
            {status === 'error' && (
              <button
                onClick={() => triggerApp(appId)}
                title={t('Retry now')}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Pause / Resume */}
            {isPaused ? (
              <button
                onClick={() => resumeApp(appId)}
                title={t('Resume')}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={() => pauseApp(appId)}
                title={t('Pause')}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
              >
                <Pause className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Browser */}
            {showBrowserButton && (
              <div ref={popoverRef} className="relative">
                <button
                  onClick={() => setShowBrowserPopover(prev => !prev)}
                  title={t('Browser')}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
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

            {/* Share */}
            <button
              onClick={() => setShowShareDialog(true)}
              title={t('Share')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {showShareDialog && (
        <ShareCurrentAppDialog
          appId={appId}
          onClose={() => setShowShareDialog(false)}
        />
      )}

      {/* ── Tab Bar ── */}
      {isAutomation && (
        <div className="flex items-center gap-0.5 px-4">
          {tabs.map(tab => {
            const Icon = tab.icon
            const isActive = currentTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={tab.onClick}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
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
      )}
    </div>
  )
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function formatTimeAgo(timestamp: number, t: (s: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - timestamp
  // Handle future timestamps (clock skew) - return "just now" for any negative diff
  if (diff <= 0) return t('just now')
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('just now')
  if (mins < 60) return t('{{count}}m ago', { count: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t('{{count}}h ago', { count: hrs })
  const days = Math.floor(hrs / 24)
  return t('{{count}}d ago', { count: days })
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
            placeholder={t('Enter URL')}
            className="flex-1 min-w-0 bg-muted border border-border rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <button
            onClick={handleOpenCustom}
            disabled={!customUrl.trim()}
            className="flex-shrink-0 p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('Open')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
