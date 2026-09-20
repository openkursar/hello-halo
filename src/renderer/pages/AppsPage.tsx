/**
 * Apps Page
 *
 * Top-level page for the Apps system. Accessible from SpacePage header.
 * Layout: Header + tab bar + split pane (app list sidebar | detail area).
 *
 * Session Detail drill-down:
 * When viewing a run's execution trace, a breadcrumb bar replaces the
 * AutomationHeader. Clicking the app name in the breadcrumb returns to
 * the Activity Thread without losing left-sidebar selection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../stores/app.store'
import { useSpaceStore } from '../stores/space.store'
import { useAppsStore } from '../stores/apps.store'
import { useAppsPageStore, tabForAppType } from '../stores/apps-page.store'
import { useTeamStore } from '../stores/team.store'
import type { AppType } from '../../shared/apps/spec-types'
import { Header } from '../components/layout/Header'
import { visibleDigitalHumans } from '../utils/people-model'
import { PeopleInbox } from '../components/apps/PeopleInbox'
import { PeopleDirectory } from '../components/apps/PeopleDirectory'
import { PersonTeams } from '../components/apps/PersonTeams'
import { CapabilityLibrary } from '../components/apps/CapabilityLibrary'
import { usePeopleViewStore } from '../stores/people-view.store'
import { AppList } from '../components/apps/AppList'
import { AutomationHeader } from '../components/apps/AutomationHeader'
import { LoginNoticeBar } from '../components/apps/LoginNoticeBar'
import { ActivityThread } from '../components/apps/ActivityThread'
import { SessionDetailView } from '../components/apps/SessionDetailView'
import { AppChatView } from '../components/apps/AppChatView'
import { AppChatContainer } from '../components/apps/AppChatContainer'
import { AppConfigPanel } from '../components/apps/AppConfigPanel'
import { McpStatusCard } from '../components/apps/McpStatusCard'
import { SkillInfoCard } from '../components/apps/SkillInfoCard'
import { EmptyState } from '../components/apps/EmptyState'
import { AppInstallDialog } from '../components/apps/AppInstallDialog'
import { ManualAddDialog } from '../components/apps/ManualAddDialog'
import { SkillInstallDialog } from '../components/apps/SkillInstallDialog'
import { UninstalledDetailView } from '../components/apps/UninstalledDetailView'
import { StoreView } from '../components/store/StoreView'
import { TeamTabContent } from '../components/team'
import { useTranslation, getCurrentLanguage } from '../i18n'
import { resolveSpecI18n } from '../utils/spec-i18n'
import { useIsMobile } from '../hooks/useIsMobile'
import { api } from '../api'
import { ChevronLeft, ChevronRight, Settings } from 'lucide-react'

export function AppsPage() {
  const { t } = useTranslation()
  const { setView, previousView } = useAppStore()
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)
  const { apps, loadApps, updateAppOverrides } = useAppsStore()
  const {
    currentTab,
    setCurrentTab,
    selectedAppId,
    detailView,
    initialAppId,
    showInstallDialog,
    selectApp,
    clearSelection,
    openActivityThread,
    setInitialAppId,
    setShowInstallDialog,
    openMarketplaceFilteredBy,
  } = useAppsPageStore()

  const isMobile = useIsMobile()

  /** When set, ManualAddDialog opens pre-targeted to that type (skips chooser) */
  const [manualAddType, setManualAddType] = useState<'mcp' | 'skill' | null>(null)
  const [showSkillInstallDialog, setShowSkillInstallDialog] = useState(false)

  /** Maps the current tab to the AppType filter used for visibility */
  const appTypeForCurrentTab = useMemo<AppType | null>(() => {
    if (currentTab === 'my-skills') return 'skill'
    if (currentTab === 'my-mcp') return 'mcp'
    if (currentTab === 'my-digital-humans') return 'automation'
    return null
  }, [currentTab])

  const selectedTeamId = useTeamStore(s => s.currentTeamId)
  const inTeamWorkbench = currentTab === 'team' && selectedTeamId !== null
  const teams = useTeamStore(s => s.teams)


  // How many teams have a decision waiting on the user — surfaced on the Teams
  // tab itself so it's visible without having to switch away and back.
  const waitingTeamsCount = useTeamStore(s => s.teams.filter(tm => tm.hasWaitingUser).length)

  /** Filter apps visible in the current tab (excludes store tab) */
  const appsForCurrentTab = useMemo(() => {
    if (!appTypeForCurrentTab) return []
    return appTypeForCurrentTab === 'automation' ? visibleDigitalHumans(apps, teams) : apps.filter(app => app.spec.type === appTypeForCurrentTab)
  }, [apps, appTypeForCurrentTab, teams])

  /**
   * Open the marketplace pre-filtered by the target type. Delegates to the
   * store action so the listing is always refetched — never silently stale.
   */
  const handleBrowseMarketplace = useCallback((type: AppType) => {
    void openMarketplaceFilteredBy(type)
  }, [openMarketplaceFilteredBy])

  useEffect(() => { void useTeamStore.getState().loadTeams() }, [])
  useEffect(() => {
    if (currentTab === 'team' || currentTab === 'my-skills' || currentTab === 'my-mcp' || currentTab === 'store' || detailView?.type === 'app-config') void loadApps()
  }, [currentTab, detailView?.type, loadApps])
  const [detailFailed, setDetailFailed] = useState(false)
  const [detailRevision, setDetailRevision] = useState(0)
  const targetAppId = initialAppId ?? selectedAppId
  useEffect(() => {
    if (!targetAppId || apps.some(app => app.id === targetAppId)) return
    let active = true
    setDetailFailed(false)
    void useAppsStore.getState().refreshApp(targetAppId).then(() => {
      if (active) { setDetailFailed(!useAppsStore.getState().apps.some(app => app.id === targetAppId)) }
    })
    return () => { active = false }
  }, [targetAppId, detailRevision])

  // Fetch available updates on mount and stay subscribed to push events so
  // the "Update" badge in AppListItem stays fresh without polling.
  const checkUpdatesAction = useAppsPageStore(s => s.checkUpdates)
  useEffect(() => {
    void checkUpdatesAction()
    const unsubscribe = api.onStoreUpgradeAvailable(() => {
      void checkUpdatesAction()
    })
    return () => {
      unsubscribe()
    }
  }, [checkUpdatesAction])

  // Build spaceId -> space name map for display
  // Always populate from both haloSpace and dedicated spaces
  const spaceMap = useMemo(() => {
    const map: Record<string, string> = {}
    if (haloSpace) map[haloSpace.id] = haloSpace.name
    for (const s of spaces) {
      map[s.id] = s.name
    }
    return map
  }, [spaces, haloSpace])

  // Auto-select initial app (from notification/badge navigation)
  useEffect(() => {
    if (initialAppId && apps.length > 0) {
      const app = apps.find(a => a.id === initialAppId)
      if (app) {
        // Switch to the correct tab for this app type (digital-humans / skills / mcp)
        const targetTab = tabForAppType(app.spec.type)
        if (currentTab !== targetTab) setCurrentTab(targetTab)
        selectApp(app.id, app.status === 'uninstalled' ? 'uninstalled' : app.spec.type, app.spaceId ?? undefined)
        setInitialAppId(null)
      }
    }
  }, [apps, initialAppId, selectApp, setInitialAppId, currentTab, setCurrentTab])

  // Clear selection when switching between split-layout tabs
  const prevTabRef = useRef(currentTab)
  useEffect(() => {
    const prev = prevTabRef.current
    prevTabRef.current = currentTab
    // Only clear when switching between the two list tabs (not to/from store)
    if (prev !== currentTab && prev !== 'store' && currentTab !== 'store') {
      // Preserve the selection when it already belongs to the new tab. This is
      // the case for programmatic cross-tab navigation (e.g. opening an MCP or
      // skill detail from a digital human's settings), which sets the tab and
      // the selection together — clearing here would wipe the just-opened
      // detail and auto-select the first app instead.
      const sel = apps.find(a => a.id === selectedAppId)
      const belongsToNewTab = sel ? tabForAppType(sel.spec.type) === currentTab : currentTab === 'my-digital-humans' && !!detailView
      if (!belongsToNewTab) clearSelection()
    }
  }, [currentTab, clearSelection, apps, selectedAppId])

  // Auto-select first app for the current tab if nothing selected (desktop only —
  // on mobile the user should see the full-width list first and tap to select)
  useEffect(() => {
    if (isMobile) return
    if (currentTab === 'store' || currentTab === 'my-digital-humans' || currentTab === 'my-skills' || currentTab === 'my-mcp') return
    if (!selectedAppId && appsForCurrentTab.length > 0) {
      const activeApps = appsForCurrentTab.filter(a => a.status !== 'uninstalled')
      const waitingApp = activeApps.find(a => a.status === 'waiting_user')
      const firstApp = waitingApp ?? activeApps[0] ?? appsForCurrentTab[0]
      selectApp(firstApp.id, firstApp.status === 'uninstalled' ? 'uninstalled' : firstApp.spec.type, firstApp.spaceId ?? undefined)
    }
  }, [appsForCurrentTab, selectedAppId, selectApp, currentTab, isMobile])

  // Resolve the selected app (for breadcrumb and detail panel)
  const selectedApp = useMemo(
    () => apps.find(a => a.id === selectedAppId),
    [apps, selectedAppId]
  )

  // Locale-resolved display fields for breadcrumbs and login notice
  const resolvedSpec = useMemo(
    () => selectedApp ? resolveSpecI18n(selectedApp.spec, getCurrentLanguage()) : undefined,
    [selectedApp]
  )
  const selectedAppName = resolvedSpec?.name

  // Login notice bar: show when browser_login exists and not dismissed
  const showLoginNotice = useMemo(() => {
    if (!selectedApp || selectedApp.spec.type !== 'automation') return false
    const browserLogin = resolvedSpec?.browser_login
    if (!browserLogin || browserLogin.length === 0) return false
    return !selectedApp.userOverrides?.loginNoticeDismissed
  }, [selectedApp, resolvedSpec])

  const isSessionDetail = detailView?.type === 'session-detail'
  const isAppChat = detailView?.type === 'app-chat'
  const isAppConfig = detailView?.type === 'app-config'
  const isUninstalledDetail = detailView?.type === 'uninstalled-detail'

  // Right-pane EmptyState is informational only; install/browse CTAs live
  // exclusively in the AppList sidebar to avoid double action surfaces.
  const emptyStateVariant = currentTab === 'my-skills'
    ? 'skill' as const
    : currentTab === 'my-mcp'
      ? 'mcp' as const
      : 'automation' as const

  const renderDetail = () => {
    if (!detailView) {
      return (
        <EmptyState
          hasApps={appsForCurrentTab.length > 0}
          variant={emptyStateVariant}
        />
      )
    }

    switch (detailView.type) {
      case 'activity-thread':
        return <ActivityThread appId={detailView.appId} />
      case 'session-detail':
        return (
          <SessionDetailView
            appId={detailView.appId}
            runId={detailView.runId}
          />
        )
      case 'app-chat':
        return (
          <AppChatContainer
            appId={detailView.appId}
            spaceId={detailView.spaceId}
          />
        )
      case 'app-teams':
        return <PersonTeams appId={detailView.appId} />
      case 'app-config':
        return <AppConfigPanel appId={detailView.appId} spaceName={selectedApp?.spaceId ? spaceMap[selectedApp.spaceId] : t('Global')} />
      case 'mcp-status':
        return <McpStatusCard appId={detailView.appId} />
      case 'skill-info':
        return <SkillInfoCard appId={detailView.appId} spaceName={selectedApp?.spaceId ? spaceMap[selectedApp.spaceId] : t('Global')} />
      case 'uninstalled-detail':
        return <UninstalledDetailView appId={detailView.appId} spaceName={selectedApp?.spaceId ? spaceMap[selectedApp.spaceId] : t('Global')} />
      default:
        return (
          <EmptyState
            hasApps={appsForCurrentTab.length > 0}
            variant={emptyStateVariant}
          />
        )
    }
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <Header
        left={
          <button
            onClick={() => inTeamWorkbench ? useTeamStore.getState().selectTeam(null) : setView(currentSpace ? 'space' : (previousView || 'home'))}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            {inTeamWorkbench ? t('Teams') : currentSpace?.name ?? t('Back')}
          </button>
        }
        right={
          <button
            onClick={() => setView('settings')}
            className="min-h-9 min-w-9 flex items-center justify-center p-1.5 hover:bg-secondary rounded-lg transition-colors"
            title={t('Settings')}
            aria-label={t('Settings')}
          >
            <Settings className="w-5 h-5" />
          </button>
        }
      />

      {/* Tab bar — kept provider-agnostic via TabButton sub-component */}
      {!inTeamWorkbench && <div className="flex items-center gap-1 px-3 sm:px-4 py-2 border-b border-border flex-shrink-0 overflow-x-auto">
        <TabButton
          active={currentTab === 'my-digital-humans'}
          label={t('My Digital Humans')}
          onClick={() => setCurrentTab('my-digital-humans')}
        />
        <TabButton
          active={currentTab === 'team'}
          label={t('Teams')}
          badge={waitingTeamsCount}
          onClick={() => setCurrentTab('team')}
        />
        <TabButton
          active={currentTab === 'my-skills' || currentTab === 'my-mcp'}
          label={t('Capability library')}
          onClick={() => setCurrentTab('my-skills')}
        />
        <TabButton active={currentTab === 'inbox'} label={t('Needs my attention')} onClick={() => setCurrentTab('inbox')} />
        <TabButton
          active={currentTab === 'store'}
          label={t('Marketplace')}
          onClick={() => setCurrentTab('store')}
        />
      </div>}

      {/* Content area */}
      {currentTab === 'store' ? (
        <StoreView />
      ) : currentTab === 'team' ? (
        <TeamTabContent />
      ) : currentTab === 'inbox' ? (
        <PeopleInbox />
      ) : currentTab === 'my-digital-humans' ? (
        selectedAppId && !selectedApp ? <div className="flex-1 p-6"><button onClick={clearSelection} className="mb-5 min-h-9 text-sm text-primary">{t('All digital humans')}</button>{detailFailed ? <p role="alert" className="text-sm text-destructive">{t('Could not load this digital human.')} <button onClick={() => setDetailRevision(value => value + 1)} className="underline">{t('Retry')}</button></p> : <p role="status" className="text-sm text-muted-foreground">{t('Loading…')}</p>}</div> : selectedAppId && selectedApp ? <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
            <button onClick={clearSelection} className="flex min-h-8 items-center gap-1 text-muted-foreground hover:text-primary"><ChevronLeft size={15} />{t('All digital humans')}</button>
            <PersonReturnLink />
            <RecentPeople />
          </div>
          {isSessionDetail ? <SessionBreadcrumb appName={selectedAppName ?? ''} runId={(detailView as { runId: string }).runId} onBack={() => openActivityThread(selectedApp.id)} /> : !isUninstalledDetail && <AutomationHeader appId={selectedAppId} spaceName={selectedApp.spaceId ? spaceMap[selectedApp.spaceId] : t('Global')} />}
          {showLoginNotice && resolvedSpec?.browser_login && detailView?.type === 'activity-thread' && <LoginNoticeBar browserLogin={resolvedSpec.browser_login} onDismiss={() => void updateAppOverrides(selectedAppId, { loginNoticeDismissed: true })} onOpenBrowser={(url, label) => api.openLoginWindow(url, label)} />}
          <div className={`min-h-0 flex-1 ${isAppChat || isSessionDetail ? 'overflow-hidden' : 'overflow-y-auto'}`}>{renderDetail()}</div>
        </div> : <PeopleDirectory spaceMap={spaceMap} onCreate={() => setShowInstallDialog(true)} />
      ) : (currentTab === 'my-skills' || currentTab === 'my-mcp') && !selectedAppId ? (
        <div className="flex min-h-0 flex-1 flex-col"><div className="flex gap-2 border-b border-border p-3"><TabButton active={currentTab === 'my-skills'} label={t('Skills')} onClick={() => setCurrentTab('my-skills')} /><TabButton active={currentTab === 'my-mcp'} label={t('MCP connections')} onClick={() => setCurrentTab('my-mcp')} /></div><CapabilityLibrary type={currentTab === 'my-skills' ? 'skill' : 'mcp'} onSelect={id => { const app = apps.find(item => item.id === id); if (app) selectApp(id, app.spec.type, app.spaceId ?? undefined) }} onAdd={() => currentTab === 'my-skills' ? setShowSkillInstallDialog(true) : setManualAddType('mcp')} /></div>
      ) : !isMobile ? (
        /* ── Desktop: split layout — left sidebar + right detail (unchanged) ── */
        <div className="flex-1 flex overflow-hidden">
          <button onClick={clearSelection} className="self-start p-3 text-xs text-primary">{t('Back to capability library')}</button>
          {/* Left: App list (fixed 240px width) */}
          <div className="w-60 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
            {currentTab === 'my-skills' ? (
              <AppList
                mode="skill"
                onInstall={() => handleBrowseMarketplace('skill')}
                onManualAdd={() => setShowSkillInstallDialog(true)}
                spaceMap={spaceMap}
              />
            ) : currentTab === 'my-mcp' ? (
              <AppList
                mode="mcp"
                onInstall={() => handleBrowseMarketplace('mcp')}
                onManualAdd={() => setManualAddType('mcp')}
                spaceMap={spaceMap}
              />
            ) : (
              <AppList
                mode="automation"
                onInstall={() => setShowInstallDialog(true)}
                spaceMap={spaceMap}
              />
            )}
          </div>

          {/* Right: Detail panel */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Session detail breadcrumb — replaces AutomationHeader when drilling into a specific run */}
            {isSessionDetail && selectedApp && (
              <SessionBreadcrumb
                appName={selectedAppName ?? ''}
                runId={(detailView as { runId: string }).runId}
                onBack={() => openActivityThread(selectedApp.id)}
              />
            )}

            {/* Automation persona card + tab bar — shown for all automation views except session detail drill-down */}
            {!isSessionDetail && !isUninstalledDetail && selectedAppId && selectedApp?.spec.type === 'automation' && (
              <>
                <AutomationHeader appId={selectedAppId} spaceName={selectedApp?.spaceId ? spaceMap[selectedApp.spaceId] : t('Global')} />
                {showLoginNotice && resolvedSpec?.browser_login && detailView?.type === 'activity-thread' && (
                  <LoginNoticeBar
                    browserLogin={resolvedSpec.browser_login}
                    onDismiss={() => {
                      if (selectedAppId) {
                        updateAppOverrides(selectedAppId, { loginNoticeDismissed: true })
                      }
                    }}
                    onOpenBrowser={(url, label) => {
                      api.openLoginWindow(url, label)
                    }}
                  />
                )}
              </>
            )}

            {/* Detail content — app-chat manages its own scroll + flex layout */}
            <div className={`flex-1 ${isAppChat || isSessionDetail ? 'overflow-hidden' : 'overflow-y-auto'}`}>
              {renderDetail()}
            </div>
          </div>
        </div>
      ) : (
        /* ── Mobile: list OR detail (push navigation) ── */
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedAppId ? (
            <>
              {/* Back button */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
                <button
                  onClick={clearSelection}
                  className="flex items-center gap-1 text-sm text-primary"
                >
                  <ChevronLeft className="w-4 h-4" />
                  {t('Back')}
                </button>
              </div>

              {/* Session detail breadcrumb */}
              {isSessionDetail && selectedApp && (
                <SessionBreadcrumb
                  appName={selectedAppName ?? ''}
                  runId={(detailView as { runId: string }).runId}
                  onBack={() => openActivityThread(selectedApp.id)}
                />
              )}

              {/* Automation header */}
              {!isSessionDetail && !isUninstalledDetail && selectedApp?.spec.type === 'automation' && (
                <>
                  <AutomationHeader appId={selectedAppId} spaceName={selectedApp?.spaceId ? spaceMap[selectedApp.spaceId] : t('Global')} />
                  {showLoginNotice && resolvedSpec?.browser_login && detailView?.type === 'activity-thread' && (
                    <LoginNoticeBar
                      browserLogin={resolvedSpec.browser_login}
                      onDismiss={() => {
                        if (selectedAppId) {
                          updateAppOverrides(selectedAppId, { loginNoticeDismissed: true })
                        }
                      }}
                      onOpenBrowser={(url, label) => {
                        api.openLoginWindow(url, label)
                      }}
                    />
                  )}
                </>
              )}

              {/* Detail content */}
              <div className={`flex-1 ${isAppChat || isSessionDetail ? 'overflow-hidden' : 'overflow-y-auto'}`}>
                {renderDetail()}
              </div>
            </>
          ) : (
            /* No selection: full-width list */
            currentTab === 'my-skills' ? (
              <AppList
                mode="skill"
                onInstall={() => handleBrowseMarketplace('skill')}
                onManualAdd={() => setShowSkillInstallDialog(true)}
                spaceMap={spaceMap}
              />
            ) : currentTab === 'my-mcp' ? (
              <AppList
                mode="mcp"
                onInstall={() => handleBrowseMarketplace('mcp')}
                onManualAdd={() => setManualAddType('mcp')}
                spaceMap={spaceMap}
              />
            ) : (
              <AppList
                mode="automation"
                onInstall={() => setShowInstallDialog(true)}
                spaceMap={spaceMap}
              />
            )
          )}
        </div>
      )}

      {/* Install dialog */}
      {showInstallDialog && (
        <AppInstallDialog
          onClose={() => setShowInstallDialog(false)}
        />
      )}

      {/* Manual add dialog (MCP only — pre-typed by tab, no chooser step) */}
      {manualAddType && (
        <ManualAddDialog
          initialType={manualAddType}
          onClose={() => setManualAddType(null)}
          onSkillAdd={() => setShowSkillInstallDialog(true)}
        />
      )}

      {/* Skill install dialog */}
      {showSkillInstallDialog && (
        <SkillInstallDialog
          onClose={() => setShowSkillInstallDialog(false)}
        />
      )}

    </div>
  )
}

// ──────────────────────────────────────────────
// Tab button sub-component
// ──────────────────────────────────────────────

interface TabButtonProps {
  active: boolean
  label: string
  onClick: () => void
  /** Count shown as a small pill next to the label; hidden when 0 or omitted. */
  badge?: number
}

function TabButton({ active, label, onClick, badge }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap ${
        active
          ? 'bg-secondary text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
      }`}
    >
      {label}
      {!!badge && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-halo-warning px-1 text-[10px] font-medium text-background">
          {badge}
        </span>
      )}
    </button>
  )
}

// ──────────────────────────────────────────────
// Breadcrumb sub-component
// ──────────────────────────────────────────────

interface SessionBreadcrumbProps {
  appName: string
  runId?: string
  label?: string
  onBack: () => void
}

function SessionBreadcrumb({ appName, runId, label, onBack }: SessionBreadcrumbProps) {
  const { t } = useTranslation()
  // Show abbreviated run ID (first 8 chars)
  const shortRunId = runId ? (runId.length > 8 ? runId.slice(0, 8) : runId) : ''
  const displayLabel = label || (shortRunId ? `${t('Run')} ${shortRunId}` : '')

  return (
    <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border bg-muted/30 flex-shrink-0">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
        {appName}
      </button>
      {displayLabel && (
        <>
          <ChevronRight className="w-3 h-3 text-muted-foreground/50" />
          <span className="text-sm text-muted-foreground">
            {displayLabel}
          </span>
        </>
      )}
    </div>
  )
}

function RecentPeople() {
  const { t } = useTranslation()
  const recent = usePeopleViewStore(state => state.recent)
  const apps = useAppsStore(state => state.apps)
  const selected = useAppsPageStore(state => state.selectedAppId)
  return <select aria-label={t('Recent digital humans')} value={selected ?? ''} onChange={event => { usePeopleViewStore.getState().rememberPerson(event.target.value); useAppsPageStore.getState().openActivityThread(event.target.value) }} className="ml-auto max-w-48 rounded-lg border border-border bg-background px-2 py-1.5"><option value={selected ?? ''}>{t('Recently visited')}</option>{recent.filter(id => id !== selected).map(id => { const app = apps.find(item => item.id === id); return app ? <option key={id} value={id}>{resolveSpecI18n(app.spec, getCurrentLanguage()).name}</option> : null })}</select>
}

function PersonReturnLink() {
  const { t } = useTranslation()
  const target = usePeopleViewStore(state => state.returnTeam)
  const inbox = usePeopleViewStore(state => state.returnInbox)
  if (inbox) return <button onClick={() => { usePeopleViewStore.setState({ returnInbox: false }); useAppsPageStore.getState().setCurrentTab('inbox') }} className="min-h-8 text-primary">{t('Return to requests')}</button>
  if (!target) return null
  return <button onClick={() => { usePeopleViewStore.setState({ teamTarget: target, returnTeam: null, returnPerson: null }); useTeamStore.getState().selectTeam(target.teamId); useAppsPageStore.getState().setCurrentTab('team') }} className="min-h-8 text-primary">{t('Return to team task')}</button>
}
