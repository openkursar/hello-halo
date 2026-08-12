/**
 * Store Detail
 *
 * Full detail view for a store app. Shows complete metadata,
 * configuration requirements, dependencies, and install button.
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { api } from '../../api'
import { ArrowLeft, ChevronDown, ChevronUp, Loader2, Check, Download, AlertCircle, RotateCcw, Globe, User } from 'lucide-react'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppsStore } from '../../stores/apps.store'
import { useAppStore } from '../../stores/app.store'
import { useSpaceStore } from '../../stores/space.store'
import { useChatStore } from '../../stores/chat.store'
import { useStoreCategories, categoryDisplay } from '../../hooks/useStoreCategories'
import { getEntryVersions, getEntryInstalls } from '../../../shared/store/store-meta'
import { useStoreEntryInstallState } from '../../hooks/useStoreEntryInstallState'
import { useStoreUpdateFlow } from './useStoreUpdateFlow'
import { useStoreCapabilities } from '../../hooks/useStoreCapabilities'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { StoreInstallDialog } from './StoreInstallDialog'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveEntryI18n, resolveSpecI18n } from '../../utils/spec-i18n'
import { AppTypeTag } from './AppTypeTag'
import { AppTypeIcon } from './AppTypeIcon'
import { installVerb, installedVerb } from './install-verb'
import { StoreDocumentation } from './StoreDocumentation'
import { SkillFileTree } from './SkillFileTree'
import type { AppType } from '../../../shared/apps/spec-types'

function formatVersionDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

/** A required MCP/skill dependency: type-glyph icon + name (with type tag
 * inline) + reason as a sub-line, matching the mockup's `.req-card`. */
function DependencyRow({ type, name, reason }: { type: AppType; name: string; reason?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border/60 bg-background">
      <AppTypeIcon type={type} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[13px] font-semibold text-foreground truncate">{name}</span>
          <AppTypeTag type={type} />
        </div>
        {reason && <p className="text-xs text-muted-foreground mt-0.5 truncate">{reason}</p>}
      </div>
    </div>
  )
}

/** Borderless muted back link, positioned inside the centered detail column
 * (matches the mockup's `.btn-back`, not a full-width header bar). */
function BackToStore({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-primary transition-colors"
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      {t('Back to Store')}
    </button>
  )
}

export function StoreDetail() {
  const { t } = useTranslation()
  const storeSelectedDetail = useAppsPageStore(state => state.storeSelectedDetail)
  const storeDetailLoading = useAppsPageStore(state => state.storeDetailLoading)
  const storeDetailError = useAppsPageStore(state => state.storeDetailError)
  const storeSelectedSlug = useAppsPageStore(state => state.storeSelectedSlug)
  const clearStoreSelection = useAppsPageStore(state => state.clearStoreSelection)
  const selectStoreApp = useAppsPageStore(state => state.selectStoreApp)
  const selectApp = useAppsPageStore(state => state.selectApp)
  const setCurrentTab = useAppsPageStore(state => state.setCurrentTab)
  const consumeStoreAutoInstall = useAppsPageStore(state => state.consumeStoreAutoInstall)
  const checkUpdates = useAppsPageStore(state => state.checkUpdates)
  const setView = useAppStore(state => state.setView)
  const spaces = useSpaceStore(state => state.spaces)
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const setCurrentSpace = useSpaceStore(state => state.setCurrentSpace)
  const refreshCurrentSpace = useSpaceStore(state => state.refreshCurrentSpace)

  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showInstallDialog, setShowInstallDialog] = useState(false)

  const capabilities = useStoreCapabilities()
  const showInstalls = capabilities?.installs === true
  // Install/update fetch spec+files from the registry; when offline the button
  // must be disabled with a hint rather than left clickable and hanging.
  const online = useOnlineStatus()
  const offlineHint = t('You are offline. Connect to the network to install or update.')

  // Resolve entry and spec from detail
  const entry = storeSelectedDetail?.entry
  const spec = storeSelectedDetail?.spec
  const registryId = storeSelectedDetail?.registryId
  const isBundlePackage = entry?.format === 'bundle'

  const { installedApp, updateInfo } = useStoreEntryInstallState(entry, registryId)

  const { start: startUpdate, busy: updating, dialogs: updateDialogs } = useStoreUpdateFlow(
    entry,
    updateInfo,
    storeSelectedDetail,
  )

  // Resolve category display: match against the type's taxonomy, falling back
  // to the raw string for legacy categories not present in the enum.
  const categories = useStoreCategories(entry?.type ?? null)
  const categoryDef = useMemo(() => {
    if (!entry?.category) return null
    return categories.find(c => c.id === entry.category) ?? null
  }, [categories, entry])

  const versions = useMemo(() => (entry ? getEntryVersions(entry) : []), [entry])

  useEffect(() => {
    if (installedApp) {
      void checkUpdates()
    }
  }, [installedApp, checkUpdates])

  // Card install buttons navigate here with an "install now" intent; raise the
  // install dialog once the detail is ready and the app is actually installable.
  useEffect(() => {
    if (!storeSelectedDetail) return
    if (consumeStoreAutoInstall() && isBundlePackage && !installedApp && entry?.type !== 'mcp') {
      setShowInstallDialog(true)
    }
  }, [storeSelectedDetail, isBundlePackage, installedApp, entry?.type, consumeStoreAutoInstall])

  // Install-intent funnel step between detail-view and install-done: the dialog
  // opening (from the detail button or a card's install-now intent) is the click.
  useEffect(() => {
    if (showInstallDialog && entry) {
      void api.trackEvent('store.install.click', { appId: entry.slug, appType: entry.type, source: 'detail' })
    }
  }, [showInstallDialog, entry?.slug, entry?.type])

  // Resolve locale-specific display text
  const locale = getCurrentLanguage()
  const resolvedEntry = useMemo(
    () => entry ? resolveEntryI18n(entry, locale) : null,
    [entry, locale]
  )
  const resolvedSpec = useMemo(
    () => spec ? resolveSpecI18n(spec, locale) : null,
    [spec, locale]
  )

  const handleInstalled = useCallback((appId: string) => {
    setShowInstallDialog(false)
    // Reload apps to show the newly installed app
    useAppsStore.getState().loadApps()
    void checkUpdates()
    console.log('[StoreDetail] App installed:', appId)
  }, [checkUpdates])

  // "Use" an already-installed app: digital humans open in their dedicated tab;
  // skills run inside a space conversation, so we open the space they're
  // installed in (global installs fall back to the current/first space).
  const handleUse = useCallback(() => {
    if (!installedApp || !entry) return
    if (entry.type === 'skill') {
      const target =
        (installedApp.spaceId ? spaces.find(s => s.id === installedApp.spaceId) : null) ??
        currentSpace ??
        spaces[0] ??
        null
      if (target) {
        setCurrentSpace(target)
        void refreshCurrentSpace()
        // Pre-fill the skill's slash command into that space's composer (consumed
        // once by InputArea on arrival); same slugging as the composer's own list.
        const command = `/${installedApp.spec.name.toLowerCase().replace(/\s+/g, '-')} `
        useChatStore.setState({ pendingComposerInput: { spaceId: target.id, text: command } })
      }
      setView('space')
      return
    }
    clearStoreSelection()
    setCurrentTab('my-digital-humans')
    selectApp(installedApp.id, 'automation')
  }, [
    installedApp,
    entry,
    spaces,
    currentSpace,
    setCurrentSpace,
    refreshCurrentSpace,
    setView,
    clearStoreSelection,
    setCurrentTab,
    selectApp,
  ])

  // Upgrade in place via updateSpec — reinstalling would throw AppAlreadyInstalledError.
  // Loading state
  if (storeDetailLoading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-background">
        <div className="w-full max-w-[880px] mx-auto px-4 sm:px-6 pt-5">
          <BackToStore onClick={clearStoreSelection} />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // Error state — fetch failed, stay on detail page and let user retry
  if (storeDetailError) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-background">
        <div className="w-full max-w-[880px] mx-auto px-4 sm:px-6 pt-5">
          <BackToStore onClick={clearStoreSelection} />
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <AlertCircle className="w-8 h-8 text-muted-foreground/50" />
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{t('Failed to load app details')}</p>
            <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">{storeDetailError}</p>
          </div>
          <button
            onClick={() => storeSelectedSlug && void selectStoreApp(storeSelectedSlug, false, 'reload')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border/60 rounded-lg hover:bg-secondary transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {t('Retry')}
          </button>
        </div>
      </div>
    )
  }

  // No detail loaded
  if (!storeSelectedDetail || !entry || !spec) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-background">
        <div className="w-full max-w-[880px] mx-auto px-4 sm:px-6 pt-5">
          <BackToStore onClick={clearStoreSelection} />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('App not found')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex-1 flex flex-col overflow-hidden bg-background">
        {/* Fixed header — only the content region below scrolls, so the header
            stays put, never shows content bleeding under it, and needs no cover
            background (same gray as the page). */}
        <div className="flex-shrink-0 w-full max-w-[880px] mx-auto px-4 sm:px-6 pt-5 pb-[18px] border-b border-border/60">
            <BackToStore onClick={clearStoreSelection} />
            <div className="flex items-start gap-4 mt-3.5">
              <AppTypeIcon type={entry.type} icon={entry.icon} name={resolvedEntry?.name ?? entry.name} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-[19px] font-bold text-foreground break-words">{resolvedEntry?.name ?? entry.name}</h1>
                  {entry.type && <AppTypeTag type={entry.type} />}
                </div>
                <div className="flex items-center gap-1.5 mt-2 flex-wrap text-xs text-muted-foreground">
                  {entry.category && entry.category !== 'other' && (
                    <>
                      <span>{categoryDef ? categoryDisplay(categoryDef, t) : entry.category}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span className="flex items-center gap-0.5">
                    <User className="w-3 h-3" />
                    {entry.author}
                  </span>
                  {showInstalls && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="flex items-center gap-0.5">
                        <Download className="w-3 h-3" />
                        {getEntryInstalls(entry) ?? 0}
                      </span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>v{entry.version}</span>
                </div>
              </div>

              {/* Install / Installed / Update button — right-aligned, pinned to the
                  bottom of the title/meta column so it sits level with the meta row */}
              <div className="flex-shrink-0 self-end flex items-center gap-3">
              {!isBundlePackage ? (
                <button
                  disabled
                  className="px-4 py-2 text-sm bg-secondary text-muted-foreground rounded-lg cursor-default"
                  title={t('Unsupported package format')}
                >
                  {t('Unsupported package format')}
                </button>
              ) : (
                <>
                  {/* Use — shown for any installed digital human / skill, even when
                      an update is available (sits alongside the update button). */}
                  {installedApp && (entry.type === 'automation' || entry.type === 'skill') && (
                    <button
                      onClick={handleUse}
                      className="px-4 py-2 text-sm font-medium border border-border/60 bg-background text-foreground rounded-lg hover:border-muted-foreground/40 transition-colors"
                    >
                      {t('Use')}
                    </button>
                  )}
                  {updateInfo ? (
                    <button
                      onClick={startUpdate}
                      disabled={updating || !online}
                      title={online ? undefined : offlineHint}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-halo-success text-white rounded-lg hover:bg-halo-success/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {updating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      {t('Update to')} v{updateInfo.latestVersion}
                    </button>
                  ) : installedApp ? (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-background border border-border/60 text-muted-foreground rounded-lg cursor-default"
                    >
                      <Check className="w-4 h-4" />
                      {installedVerb(t, entry.type)}
                    </button>
                  ) : entry.type === 'mcp' ? (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-secondary text-muted-foreground rounded-lg cursor-not-allowed opacity-60"
                      title={t('MCP store install is coming soon. Use Manual Add to configure MCP servers.')}
                    >
                      {t('Coming Soon')}
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowInstallDialog(true)}
                      disabled={!online}
                      title={online ? undefined : offlineHint}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Download className="w-4 h-4" />
                      {installVerb(t, entry.type)}
                    </button>
                  )}
                </>
              )}
              </div>
            </div>
          </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[880px] mx-auto px-4 sm:px-6 pt-[22px] pb-8">
            <div className="flex flex-col sm:flex-row gap-6 sm:gap-7">
            <div className="flex-1 min-w-0 space-y-6">
          {/* Description */}
          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Description')}
            </h2>
            <p className="text-sm text-foreground whitespace-pre-wrap">
              {resolvedSpec?.description ?? spec.description ?? entry.description}
            </p>
          </div>

          {/* Documentation (SKILL.md) — skills only, lazily fetched */}
          {entry.type === 'skill' && (
            <StoreDocumentation
              slug={entry.slug}
              version={entry.version}
              inlineContent={spec.type === 'skill' ? spec.skill_files?.['SKILL.md'] : undefined}
            />
          )}

          {/* Config Schema Preview */}
          {(resolvedSpec?.config_schema ?? spec.config_schema) && (resolvedSpec?.config_schema ?? spec.config_schema)!.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('Configuration')}
              </h2>
              <div className="rounded-lg border border-border/60 bg-background overflow-hidden divide-y divide-border/60">
                {(resolvedSpec?.config_schema ?? spec.config_schema)!.map(field => (
                  <div key={field.key} className="flex items-center gap-2.5 px-3.5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] font-medium text-foreground">
                        {field.label}
                        {field.required && <span className="text-red-400 ml-0.5">*</span>}
                      </span>
                      {field.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-[11px] font-mono px-1.5 py-0.5 rounded border border-border/60 bg-muted text-muted-foreground">
                      {field.type}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {spec.requires && (spec.requires.mcps?.length || spec.requires.skills?.length) && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('Dependencies')}
              </h2>
              <div className="space-y-1.5">
                {spec.requires.mcps?.map(mcp => (
                  <DependencyRow key={mcp.id} type="mcp" name={mcp.id} reason={mcp.reason} />
                ))}
                {spec.requires.skills?.map(skill => {
                  const skillId = typeof skill === 'string' ? skill : skill.id
                  const skillReason = typeof skill === 'string' ? undefined : skill.reason
                  return (
                    <DependencyRow key={skillId} type="skill" name={skillId} reason={skillReason} />
                  )
                })}
              </div>
            </div>
          )}

          {/* Browser Login Requirements */}
          {spec.type === 'automation' && spec.browser_login && spec.browser_login.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('Required Logins')}
              </h2>
              <div className="space-y-1.5">
                {(resolvedSpec?.browser_login ?? spec.browser_login).map(entry => (
                  <div
                    key={entry.url}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20"
                  >
                    <Globe className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    <span className="text-sm text-foreground">{entry.label}</span>
                    <span className="text-xs text-muted-foreground ml-auto truncate max-w-[120px] sm:max-w-[200px]">{entry.url}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('This automation requires you to be logged in to the above websites in the Halo browser.')}
              </p>
            </div>
          )}

          {/* System Prompt — collapsible content panel (mockup .detail-collapse) */}
          {spec.type === 'automation' && spec.system_prompt && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('System Prompt')}
              </h2>
              <div className="rounded-lg border border-border/60 bg-background overflow-hidden">
                <button
                  onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                  className="flex w-full items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showSystemPrompt ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                  {t('View system prompt')}
                </button>
                {showSystemPrompt && (
                  <pre className="text-xs leading-relaxed text-muted-foreground border-t border-border/60 px-4 py-3 whitespace-pre-wrap break-words font-mono">
                    {spec.system_prompt}
                  </pre>
                )}
              </div>
            </div>
          )}

            </div>

            {/* Aside: tags + metadata cards */}
            <div className="sm:w-60 sm:flex-shrink-0 space-y-4">
              {spec.type === 'skill' && Object.keys(spec.skill_files ?? {}).length > 1 && (
                <SkillFileTree paths={Object.keys(spec.skill_files ?? {})} />
              )}
              {entry.tags.length > 0 && (
                <div className="rounded-[10px] border border-border/60 bg-background p-3.5 space-y-2.5">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('Tags')}
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {entry.tags.map(tag => (
                      <span
                        key={tag}
                        className="text-xs px-2 py-0.5 rounded bg-muted/40 text-muted-foreground whitespace-nowrap"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-[10px] border border-border/60 bg-background p-3.5 space-y-2.5">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('Details')}
                </h4>
                <div className="flex flex-col gap-2 text-xs">
                  <div className="flex justify-between gap-2.5">
                    <span className="flex-shrink-0 text-muted-foreground">{t('Format')}</span>
                    <span className="text-right text-foreground">{entry.format}</span>
                  </div>
                  {entry.min_app_version && (
                    <div className="flex justify-between gap-2.5">
                      <span className="flex-shrink-0 text-muted-foreground">{t('Min version')}</span>
                      <span className="text-right text-foreground">{entry.min_app_version}</span>
                    </div>
                  )}
                  {entry.updated_at && (
                    <div className="flex justify-between gap-2.5">
                      <span className="flex-shrink-0 text-muted-foreground">{t('Updated')}</span>
                      <span className="text-right text-foreground">{formatVersionDate(entry.updated_at)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Version history — collapsed by default, expands into a timeline */}
              {versions.length > 0 && (
                <div className="rounded-[10px] border border-border/60 bg-background overflow-hidden">
                  <button
                    onClick={() => setShowVersions(!showVersions)}
                    className="flex w-full items-center gap-2 px-3.5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showVersions ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                    {t('Version History')}
                  </button>
                  {showVersions && (
                    <ul className="border-t border-border/60 pl-[21px] pr-3.5 pt-3.5 pb-1">
                      {versions.map((v, i) => (
                        <li
                          key={v.version}
                          className={`relative pl-4 border-l ${
                            i === versions.length - 1 ? 'border-transparent pb-0' : 'border-border/60 pb-4'
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className="absolute -left-[3px] top-1.5 w-1.5 h-1.5 rounded-full bg-primary"
                          />
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[13px] font-medium text-foreground">v{v.version}</span>
                            {v.publishedAt && (
                              <span className="text-xs text-muted-foreground">{formatVersionDate(v.publishedAt)}</span>
                            )}
                          </div>
                          {v.changelog && (
                            <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line leading-relaxed">{v.changelog}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
          </div>
        </div>
      </div>

      {/* Install dialog */}
      {showInstallDialog && storeSelectedDetail && isBundlePackage && (
        <StoreInstallDialog
          detail={storeSelectedDetail}
          onClose={() => setShowInstallDialog(false)}
          onInstalled={handleInstalled}
          showGlobalOption={entry?.type === 'mcp' || entry?.type === 'skill'}
        />
      )}

      {updateDialogs}
    </>
  )
}
