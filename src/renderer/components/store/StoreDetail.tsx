/**
 * Store Detail
 *
 * Full detail view for a store app. Shows complete metadata,
 * configuration requirements, dependencies, and install button.
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { ChevronLeft, ChevronDown, ChevronUp, Loader2, Check, Download, AlertCircle, RotateCcw, Globe } from 'lucide-react'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppsStore } from '../../stores/apps.store'
import { STORE_CATEGORY_META } from '../../../shared/store/store-types'
import { StoreInstallDialog } from './StoreInstallDialog'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveEntryI18n, resolveSpecI18n } from '../../utils/spec-i18n'
import { AppTypeBadge } from './AppTypeBadge'
import { StoreDocumentation } from './StoreDocumentation'
import { api } from '../../api'

export function StoreDetail() {
  const { t } = useTranslation()
  const storeSelectedDetail = useAppsPageStore(state => state.storeSelectedDetail)
  const storeDetailLoading = useAppsPageStore(state => state.storeDetailLoading)
  const storeDetailError = useAppsPageStore(state => state.storeDetailError)
  const storeSelectedSlug = useAppsPageStore(state => state.storeSelectedSlug)
  const availableUpdates = useAppsPageStore(state => state.availableUpdates)
  const clearStoreSelection = useAppsPageStore(state => state.clearStoreSelection)
  const selectStoreApp = useAppsPageStore(state => state.selectStoreApp)
  const checkUpdates = useAppsPageStore(state => state.checkUpdates)
  const apps = useAppsStore(state => state.apps)

  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  const [showInstallDialog, setShowInstallDialog] = useState(false)
  const [updateInstalling, setUpdateInstalling] = useState(false)
  const [updateInstallError, setUpdateInstallError] = useState<string | null>(null)

  // Resolve entry and spec from detail
  const entry = storeSelectedDetail?.entry
  const spec = storeSelectedDetail?.spec
  const registryId = storeSelectedDetail?.registryId
  const isBundlePackage = entry?.format === 'bundle'

  // Check if this app is already installed (prefer exact slug+registry match).
  const installedApp = useMemo(() => {
    if (!entry || !registryId) return null

    const exact = apps.find(a => {
      const storeSlug = a.spec.store?.slug
      const storeRegistryId = a.spec.store?.registry_id
      return storeSlug === entry.slug && storeRegistryId === registryId
    })
    if (exact) return exact

    // Backward compatibility for earlier installs that predate registry_id.
    return apps.find(a => {
      const storeSlug = a.spec.store?.slug
      const storeRegistryId = a.spec.store?.registry_id
      return storeSlug === entry.slug && !storeRegistryId
    }) ?? null
  }, [apps, entry, registryId])

  // Check for available update
  const updateInfo = useMemo(() => {
    if (!installedApp) return null
    return availableUpdates.find(u => u.appId === installedApp.id) ?? null
  }, [availableUpdates, installedApp])

  // Resolve category display (icon + translated label)
  const categoryMeta = useMemo(() => {
    if (!entry?.category) return null
    return STORE_CATEGORY_META.find(c => c.id === entry.category) ?? null
  }, [entry])

  useEffect(() => {
    if (installedApp) {
      void checkUpdates()
    }
  }, [installedApp, checkUpdates])

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

  // Upgrade in place via updateSpec — reinstalling would throw AppAlreadyInstalledError.
  const handleUpdateInPlace = useCallback(async () => {
    if (!entry || !installedApp) return
    setUpdateInstallError(null)
    setUpdateInstalling(true)
    try {
      const res = await api.storeApplyUpgrade(installedApp.id, 'force')
      if (res.success) {
        useAppsStore.getState().loadApps()
        void checkUpdates()
      } else {
        setUpdateInstallError(res.error ?? t('Update failed. Please try again.'))
      }
    } catch (err) {
      setUpdateInstallError(err instanceof Error ? err.message : t('Update failed'))
    } finally {
      setUpdateInstalling(false)
    }
  }, [entry, installedApp, checkUpdates, t])

  // Loading state
  if (storeDetailLoading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          <button
            onClick={clearStoreSelection}
            className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t('Back to Store')}
          </button>
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
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          <button
            onClick={clearStoreSelection}
            className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t('Back to Store')}
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <AlertCircle className="w-8 h-8 text-muted-foreground/50" />
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{t('Failed to load app details')}</p>
            <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">{storeDetailError}</p>
          </div>
          <button
            onClick={() => storeSelectedSlug && void selectStoreApp(storeSelectedSlug)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg hover:bg-secondary transition-colors"
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
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          <button
            onClick={clearStoreSelection}
            className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t('Back to Store')}
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('App not found')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto">
        {/* Back button */}
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          <button
            onClick={clearStoreSelection}
            className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors font-medium"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t('Back to Store')}
          </button>
        </div>

        <div className="p-6 space-y-6 max-w-3xl">
          {/* Header: Icon + Name + Version + Author */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="flex items-start gap-3 min-w-0">
              {entry.icon && (
                <span className="text-3xl flex-shrink-0">{entry.icon}</span>
              )}
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-foreground break-words">{resolvedEntry?.name ?? entry.name}</h1>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-xs text-muted-foreground">v{entry.version}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('by')} {entry.author}
                  </span>
                  {categoryMeta && (
                    <span className="text-xs text-muted-foreground">
                      {categoryMeta.icon} {t(categoryMeta.labelKey)}
                    </span>
                  )}
                  {entry.type && (
                    <AppTypeBadge type={entry.type} />
                  )}
                </div>
              </div>
            </div>

            {/* Install / Installed / Update button */}
            <div className="flex-shrink-0 flex flex-col items-start sm:items-end gap-1">
              {!isBundlePackage ? (
                <button
                  disabled
                  className="px-4 py-2 text-sm bg-secondary text-muted-foreground rounded-lg cursor-default"
                  title={t('Unsupported package format')}
                >
                  {t('Unsupported package format')}
                </button>
              ) : entry?.type === 'mcp' ? (
                // MCP: store install disabled — manual add only
                <>
                  {installedApp && !updateInfo ? (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-secondary text-muted-foreground rounded-lg cursor-default"
                    >
                      <Check className="w-4 h-4" />
                      {t('Installed')}
                    </button>
                  ) : updateInfo ? (
                    <button
                      onClick={handleUpdateInPlace}
                      disabled={updateInstalling}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {updateInstalling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      {t('Update to')} v{updateInfo.latestVersion}
                    </button>
                  ) : (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-secondary text-muted-foreground rounded-lg cursor-not-allowed opacity-60"
                      title={t('MCP store install is coming soon. Use Manual Add to configure MCP servers.')}
                    >
                      {t('Coming Soon')}
                    </button>
                  )}
                  {updateInstallError && (
                    <p className="text-xs text-red-400">{updateInstallError}</p>
                  )}
                </>
              ) : entry?.type === 'skill' ? (
                // Skill: normal install flow
                <>
                  {installedApp && !updateInfo ? (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-secondary text-muted-foreground rounded-lg cursor-default"
                    >
                      <Check className="w-4 h-4" />
                      {t('Installed')}
                    </button>
                  ) : updateInfo ? (
                    <button
                      onClick={handleUpdateInPlace}
                      disabled={updateInstalling}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {updateInstalling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      {t('Update to')} v{updateInfo.latestVersion}
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowInstallDialog(true)}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      {t('Install')}
                    </button>
                  )}
                  {updateInstallError && (
                    <p className="text-xs text-red-400">{updateInstallError}</p>
                  )}
                </>
              ) : (
                <>
                  {installedApp && !updateInfo ? (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-secondary text-muted-foreground rounded-lg cursor-default"
                    >
                      <Check className="w-4 h-4" />
                      {t('Installed')}
                    </button>
                  ) : updateInfo ? (
                    <button
                      onClick={() => setShowInstallDialog(true)}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      {t('Update to')} v{updateInfo.latestVersion}
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowInstallDialog(true)}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      {t('Install')}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

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
              <div className="space-y-1.5">
                {(resolvedSpec?.config_schema ?? spec.config_schema)!.map(field => (
                  <div
                    key={field.key}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/50 border border-border"
                  >
                    <div className="min-w-0">
                      <span className="text-sm text-foreground">{field.label}</span>
                      {field.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                      <span className="text-xs px-2 py-0.5 rounded bg-secondary text-muted-foreground">
                        {field.type}
                      </span>
                      {field.required && (
                        <span className="text-xs text-red-400">{t('required')}</span>
                      )}
                    </div>
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
                  <div
                    key={mcp.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border"
                  >
                    <span className="text-xs px-2 py-0.5 rounded bg-secondary text-muted-foreground">MCP</span>
                    <span className="text-sm text-foreground">{mcp.id}</span>
                    {mcp.reason && (
                      <span className="text-xs text-muted-foreground ml-auto">{mcp.reason}</span>
                    )}
                  </div>
                ))}
                {spec.requires.skills?.map(skill => {
                  const skillId = typeof skill === 'string' ? skill : skill.id
                  const skillReason = typeof skill === 'string' ? undefined : skill.reason
                  return (
                    <div
                      key={skillId}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50 border border-border"
                    >
                      <span className="text-xs px-2 py-0.5 rounded bg-secondary text-muted-foreground">{t('Skill')}</span>
                      <span className="text-sm text-foreground">{skillId}</span>
                      {skillReason && (
                        <span className="text-xs text-muted-foreground ml-auto">{skillReason}</span>
                      )}
                    </div>
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

          {/* System Prompt (collapsible) */}
          {spec.type === 'automation' && spec.system_prompt && (
            <div className="space-y-2">
              <button
                onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
              >
                {showSystemPrompt ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
                {t('System Prompt')}
              </button>
              {showSystemPrompt && (
                <pre className="text-xs text-foreground bg-secondary/50 border border-border rounded-lg p-4 overflow-x-auto whitespace-pre-wrap font-mono max-h-80 overflow-y-auto">
                  {spec.system_prompt}
                </pre>
              )}
            </div>
          )}

          {/* Tags */}
          {entry.tags.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('Tags')}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {entry.tags.map(tag => (
                  <span
                    key={tag}
                    className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Metadata footer */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-4 pt-2 border-t border-border text-xs text-muted-foreground">
            <span>{t('Format')}: {entry.format}</span>
            {entry.min_app_version && (
              <span>{t('Min version')}: {entry.min_app_version}</span>
            )}
            {entry.updated_at && (
              <span>{t('Updated')}: {new Date(entry.updated_at).toLocaleDateString()}</span>
            )}
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
    </>
  )
}
