/**
 * AISourcesSection - AI Sources Management Component (v2)
 *
 * Manages the list of configured AI sources using the v2 data structure.
 * Displays current sources, allows switching, adding, editing, and deleting.
 *
 * Features:
 * - List of configured sources with status indicators
 * - Quick switch between sources
 * - Add new source via ProviderSelector
 * - Edit existing source configuration
 * - Delete source with confirmation
 * - Dynamic OAuth provider support (configured via product.json)
 */

import { useState, useEffect, useRef } from 'react'
import {
  Plus, Check, ChevronRight, Edit2, Trash2, LogOut, Loader2, Key, Globe, RefreshCw
} from 'lucide-react'
import type {
  AISource,
  AISourcesConfig,
  HaloConfig
} from '../../types'
import { getBuiltinProvider } from '../../types'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { api } from '../../api'
import { ProviderSelector } from './ProviderSelector'
import { DelegatedLoginDialog } from './DelegatedLoginDialog'
import { getBrandIcon } from '../icons/BrandIcons'
import { ProviderIconTile } from '../icons/ProviderIconTile'
import { OAuthRedirectLogin } from '../ai-config/OAuthRedirectLogin'
import { useOAuthLogin } from '../../hooks/useOAuthLogin'
import { resolveLocalizedText, type LocalizedText, type AuthProviderConfig } from '../../../shared/types'
import { CLI_DELEGATED_PROVIDER_ID } from '../../../shared/constants/claude-models'

// ============================================================================
// Helper functions for dynamic providers
// ============================================================================

function getLocalizedText(value: LocalizedText): string {
  return resolveLocalizedText(value, getCurrentLanguage())
}

interface AISourcesSectionProps {
  config: HaloConfig
  setConfig: (config: HaloConfig) => void
}

export function AISourcesSection({ config, setConfig }: AISourcesSectionProps) {
  const { t } = useTranslation()

  // Get v2 aiSources
  const aiSources: AISourcesConfig = config.aiSources || {
    version: 2,
    currentId: null,
    sources: []
  }

  // State
  const [showAddForm, setShowAddForm] = useState(false)
  // Preset-API provider entry currently being added (from the bottom list in
  // settings). When set, the section renders a preset-add form via
  // `ProviderSelector` with `presetProvider`. Mutually exclusive with
  // `showAddForm` (generic add) and `editingSourceId` (edit).
  const [addingPresetProvider, setAddingPresetProvider] = useState<AuthProviderConfig | null>(null)
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null)
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)

  const [loggingOutSourceId, setLoggingOutSourceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renameSource, setRenameSource] = useState<{ sourceId: string; name: string } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Delegated (CLI-managed) login dialog
  const [delegatedLoginOpen, setDelegatedLoginOpen] = useState(false)

  // Dynamic OAuth providers from product.json
  const [oauthProviders, setOAuthProviders] = useState<AuthProviderConfig[]>([])

  // Fetch available OAuth providers on mount
  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const result = await api.authGetProviders()
        if (!mountedRef.current) return
        if (!result.success || !result.data) throw new Error(result.error || t('Failed to load login providers'))
        const providers = (result.data as AuthProviderConfig[]).filter(p => p.type !== 'custom')
        setOAuthProviders(providers)
      } catch (err) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : t('Failed to load login providers'))
      }
    }
    fetchProviders()
  }, [])

  const reloadConfig = async () => {
    const result = await api.getConfig()
    if (!result.success || !result.data) throw new Error(result.error || t('Failed to load config'))
    if (mountedRef.current) setConfig(result.data as HaloConfig)
  }

  const oauth = useOAuthLogin({ onSignedIn: reloadConfig, onError: setError })

  // Handle switch source (atomic: backend reads latest tokens from disk)
  const handleSwitchSource = async (sourceId: string) => {
    const result = await api.aiSourcesSwitchSource(sourceId)
    if (result.success && result.data) {
      setConfig({ ...config, aiSources: result.data as AISourcesConfig })
    }
  }

  // Handle save source (add or update)
  const handleSaveSource = async (source: AISource) => {
    const existingIndex = aiSources.sources.findIndex(s => s.id === source.id)

    // Add or update source atomically (backend reads from disk, preserves tokens)
    const saveResult = existingIndex >= 0
      ? await api.aiSourcesUpdateSource(source.id, source)
      : await api.aiSourcesAddSource(source)

    if (!saveResult.success) {
      console.error('[AISourcesSection] Failed to save source:', saveResult.error)
      return
    }

    // Switch to saved source as current, get latest data from disk
    const switchResult = await api.aiSourcesSwitchSource(source.id)
    if (switchResult.success && switchResult.data) {
      setConfig({ ...config, aiSources: switchResult.data as AISourcesConfig, isFirstLaunch: false, modelConfigSkipped: false })
    }

    // Persist flags (no aiSources in payload, safe). Clearing modelConfigSkipped
    // ensures a user who once deferred, then configured a source, is no longer
    // suppressed from the setup re-entry guard if they later delete all sources.
    await api.setConfig({ isFirstLaunch: false, modelConfigSkipped: false })

    setShowAddForm(false)
    setEditingSourceId(null)
    setAddingPresetProvider(null)
  }

  // Handle delete source
  const handleDeleteSource = async (sourceId: string) => {
    const result = await api.aiSourcesDeleteSource(sourceId)
    if (result.success && result.data) {
      setConfig({ ...config, aiSources: result.data as AISourcesConfig })
    }
    setDeletingSourceId(null)
  }

  // Handle OAuth logout
  const handleOAuthLogout = async (sourceId: string) => {
    try {
      setLoggingOutSourceId(sourceId)
      setError(null)
      const result = await api.authLogout(sourceId)
      if (!result.success) throw new Error(result.error || t('Unable to sign out'))
      await reloadConfig()
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : t('Unable to sign out'))
    } finally {
      if (mountedRef.current) setLoggingOutSourceId(null)
    }
  }

  const handleRenameSource = async () => {
    if (!renameSource?.name.trim() || renaming) return
    setRenaming(true)
    setError(null)
    try {
      const result = await api.aiSourcesUpdateSource(renameSource.sourceId, { name: renameSource.name.trim() })
      if (!result.success) throw new Error(result.error || t('Failed to rename account'))
      await reloadConfig()
      if (mountedRef.current) setRenameSource(null)
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : t('Failed to rename account'))
    } finally {
      if (mountedRef.current) setRenaming(false)
    }
  }

  // Get display info for a source
  const getSourceDisplayInfo = (source: AISource) => {
    const builtin = getBuiltinProvider(source.provider)
    return {
      name: source.name || builtin?.name || source.provider,
      icon: builtin?.icon || 'key',
      description: builtin?.description || ''
    }
  }

  // Render source card
  const renderSourceCard = (source: AISource) => {
    const isCurrent = source.id === aiSources.currentId
    const isExpanded = expandedSourceId === source.id
    const displayInfo = getSourceDisplayInfo(source)
    const isOAuth = source.authType === 'oauth'
    const isDelegated = source.authType === 'delegated'
    // Neither kind stores a key in Halo, so both hide the key-editing affordances.
    const isCredentialless = isOAuth || isDelegated

    return (
      <div
        key={source.id}
        className={`border rounded-lg transition-all ${
          isCurrent
            ? 'border-primary bg-primary/5'
            : 'border-border-primary bg-surface-secondary'
        }`}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 p-3 cursor-pointer"
          onClick={() => setExpandedSourceId(isExpanded ? null : source.id)}
        >
          {/* Radio button for selection */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (!isCurrent) handleSwitchSource(source.id)
            }}
            className={`w-5 h-5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
              isCurrent
                ? 'border-primary bg-primary'
                : 'border-border-secondary hover:border-primary'
            }`}
          >
            {isCurrent && <Check size={12} className="text-white" />}
          </button>

          {/* Icon */}
          <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center ${
            isCurrent ? 'bg-primary/20' : 'bg-surface-tertiary'
          }`}>
            {(() => {
              const Brand = getBrandIcon(source.provider)
              if (Brand) return <Brand size={18} className="text-text-secondary" />
              return isCredentialless
                ? <Globe size={18} className="text-text-secondary" />
                : <Key size={18} className="text-text-secondary" />
            })()}
          </div>

          {/* Name & Model */}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-text-primary truncate">
              {displayInfo.name}
            </div>
            <div className="text-xs text-text-tertiary truncate">
              {source.model || t('No model selected')}
            </div>
            {isCredentialless && source.user?.name && (
              <div className="text-xs text-text-secondary truncate" title={source.user.name}>
                {source.user.name}
              </div>
            )}
          </div>

          {/* Expand arrow */}
          <ChevronRight
            size={18}
            className={`shrink-0 text-text-tertiary transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-0 border-t border-border-secondary">
            <div className="pt-3 space-y-2">
              {/* Provider */}
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">{t('Provider')}</span>
                <span className="text-text-primary">{source.provider}</span>
              </div>

              {/* Auth Type */}
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">{t('Auth Type')}</span>
                <span className="text-text-primary">
                  {isDelegated ? t('Claude Code CLI') : isOAuth ? t('OAuth') : t('API Key')}
                </span>
              </div>

              {/* API URL — only sources that own an endpoint */}
              {!isCredentialless && (
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary">{t('API URL')}</span>
                  <span className="text-text-primary truncate max-w-[200px]">
                    {source.apiUrl}
                  </span>
                </div>
              )}

              {renameSource?.sourceId === source.id && (
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    aria-label={t('Account name')}
                    value={renameSource.name}
                    onChange={event => setRenameSource({ sourceId: source.id, name: event.target.value })}
                    disabled={renaming}
                    className="w-full min-w-0 flex-1 px-3 py-2 bg-background border border-border rounded-md text-sm"
                    onKeyDown={event => {
                      if (event.key === 'Enter') void handleRenameSource()
                    }}
                  />
                  <div className="flex gap-2">
                    <button onClick={handleRenameSource} disabled={renaming || !renameSource.name.trim()} className="px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm disabled:opacity-50">
                      {t('Save')}
                    </button>
                    <button onClick={() => setRenameSource(null)} disabled={renaming} className="px-3 py-2 bg-surface-tertiary rounded-md text-sm">
                      {t('Cancel')}
                    </button>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-2 pt-2">
                {isOAuth && (
                  <>
                    <button
                      onClick={() => oauth.start(source.provider, source.id)}
                      disabled={!!oauth.login}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-text-secondary
                               bg-surface-tertiary hover:bg-surface-primary rounded-md transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={14} />
                      {t('Reauthenticate')}
                    </button>
                    <button
                      onClick={() => setRenameSource({ sourceId: source.id, name: source.name })}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-text-secondary
                               bg-surface-tertiary hover:bg-surface-primary rounded-md transition-colors"
                    >
                      <Edit2 size={14} />
                      {t('Rename')}
                    </button>
                  </>
                )}
                {isCredentialless ? (
                  // No key to edit. For delegated sources this only removes the
                  // source — the CLI keeps its own credential either way.
                  <button
                    onClick={() => handleOAuthLogout(source.id)}
                    disabled={loggingOutSourceId === source.id}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm text-red-500
                             bg-red-500/10 hover:bg-red-500/20 rounded-md transition-colors"
                  >
                    {loggingOutSourceId === source.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <LogOut size={14} />
                    )}
                    {isDelegated ? t('Remove') : t('Logout')}
                  </button>
                ) : (
                  // API Key: edit and delete
                  <>
                    <button
                      onClick={() => setEditingSourceId(source.id)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-text-secondary
                               bg-surface-tertiary hover:bg-surface-primary rounded-md transition-colors"
                    >
                      <Edit2 size={14} />
                      {t('Edit')}
                    </button>
                    <button
                      onClick={() => setDeletingSourceId(source.id)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-red-500
                               bg-red-500/10 hover:bg-red-500/20 rounded-md transition-colors"
                    >
                      <Trash2 size={14} />
                      {t('Delete')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Show add/edit form
  if (showAddForm || editingSourceId || addingPresetProvider) {
    const title = editingSourceId
      ? t('Edit Provider')
      : addingPresetProvider
        ? resolveLocalizedText(addingPresetProvider.displayName, getCurrentLanguage())
        : t('Add AI Provider')
    return (
      <div className="space-y-4">
        <h3 className="font-medium text-text-primary">{title}</h3>
        <ProviderSelector
          aiSources={aiSources}
          onSave={handleSaveSource}
          onCancel={() => {
            setShowAddForm(false)
            setEditingSourceId(null)
            setAddingPresetProvider(null)
          }}
          editingSourceId={editingSourceId}
          presetProvider={addingPresetProvider ?? undefined}
        />
      </div>
    )
  }

  // Show delete confirmation
  if (deletingSourceId) {
    const sourceToDelete = aiSources.sources.find(s => s.id === deletingSourceId)
    return (
      <div className="p-4 bg-surface-secondary rounded-lg border border-border-primary space-y-4">
        <h3 className="font-medium text-text-primary">{t('Confirm Delete')}</h3>
        <p className="text-text-secondary">
          {t('Are you sure you want to delete')} <strong>{sourceToDelete?.name}</strong>?
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => setDeletingSourceId(null)}
            className="flex-1 px-4 py-2 text-text-secondary hover:bg-surface-tertiary rounded-md"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={() => handleDeleteSource(deletingSourceId)}
            className="flex-1 px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600"
          >
            {t('Delete')}
          </button>
        </div>
      </div>
    )
  }

  if (oauth.login?.redirect) {
    const provider = oauthProviders.find(entry => entry.type === oauth.login?.provider)
    return (
      <div className="min-w-0 p-4 bg-surface-secondary rounded-lg border border-border-primary">
        <OAuthRedirectLogin
          title={provider ? getLocalizedText(provider.displayName) : oauth.login.provider}
          redirect={oauth.login.redirect}
          onOpenWindow={oauth.openLoginWindow}
          onSubmitCode={oauth.submitCode}
          onCodeChange={oauth.setManualCode}
          onCopyLink={oauth.copyLoginUrl}
          onCancel={oauth.cancel}
        />
      </div>
    )
  }

  // Show OAuth login state
  if (oauth.login) {
    const { phase, userCode, verificationUri } = oauth.login
    const status = phase === 'starting'
      ? t('Starting login...')
      : userCode ? t('Enter the code in your browser') : t('Waiting for login...')
    return (
      <div className="p-4 bg-surface-secondary rounded-lg border border-border-primary space-y-4">
        <div className="flex items-center gap-3">
          <Loader2 size={20} className="animate-spin text-primary" />
          <span className="text-text-primary">{status}</span>
        </div>
        {userCode && (
          <div className="p-3 bg-surface-tertiary rounded-md text-center">
            <p className="text-sm text-text-secondary mb-2">{t('Your code')}:</p>
            <p className="text-2xl font-mono font-bold text-primary">{userCode}</p>
            {verificationUri && (
              <a
                href={verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline mt-2 block"
              >
                {t('Open verification page')}
              </a>
            )}
          </div>
        )}
        <button onClick={oauth.cancel} className="w-full px-4 py-2 text-sm text-text-secondary hover:bg-surface-tertiary rounded-md">
          {t('Cancel')}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div role="alert" className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
          <p className="text-sm text-destructive break-words">{error}</p>
        </div>
      )}
      {/* Sources List */}
      {aiSources.sources.length > 0 ? (
        <div className="space-y-2">
          {aiSources.sources.map(renderSourceCard)}
        </div>
      ) : (
        <div className="p-6 text-center text-text-tertiary bg-surface-secondary rounded-lg border border-border-primary">
          {t('No AI sources configured')}
        </div>
      )}

      {/* Add Source Button */}
      <button
        onClick={() => setShowAddForm(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed
                 border-border-secondary hover:border-primary text-text-secondary hover:text-primary
                 rounded-lg transition-colors"
      >
        <Plus size={18} />
        {t('Add AI Provider')}
      </button>

      {/* Dynamic auth providers from product.json — split into two groups:
          OAuth entries (interactive login) and Preset-API entries (API key
          form). Preset entries used to be lumped into the OAuth group and
          silently failed on click because they have no provider module. */}
      {(() => {
        // Preset entries: filter out those already added. Preset sources are
        // persisted with `provider: 'custom'` (no dedicated ProviderId), so we
        // identify them by the explicit `isPreset` flag combined with a
        // baseUrl match — `apiUrl` is the stable identity of a preset entry.
        const availablePresetProviders = oauthProviders.filter(provider => {
          if (!provider.preset) return false
          return !aiSources.sources.some(
            s => s.isPreset === true && s.apiUrl === provider.preset!.baseUrl
          )
        })

        const availableOAuthProviders = oauthProviders.filter(provider => {
          if (provider.preset) return false
          // The CLI owns one external credential slot; managed OAuth accounts do not.
          if (provider.type === CLI_DELEGATED_PROVIDER_ID) {
            return !api.isRemoteMode() && !aiSources.sources.some(s => s.provider === provider.type)
          }
          return true
        })

        if (availablePresetProviders.length === 0 && availableOAuthProviders.length === 0) {
          return null
        }

        const renderProviderButton = (
          provider: AuthProviderConfig,
          onClick: () => void
        ) => {
          return (
            <button
              key={provider.type}
              onClick={onClick}
              className="flex items-center gap-3 w-full p-3 bg-surface-secondary hover:bg-surface-tertiary
                       border border-border-primary rounded-lg transition-colors"
            >
              <ProviderIconTile provider={provider} size="md" />
              <div className="flex-1 min-w-0 text-left">
                <div className="font-medium text-text-primary truncate">
                  {getLocalizedText(provider.displayName)}
                </div>
                <div className="text-xs text-text-secondary break-words">
                  {!provider.preset && provider.type !== CLI_DELEGATED_PROVIDER_ID && aiSources.sources.some(s => s.provider === provider.type)
                    ? t('Add another account')
                    : getLocalizedText(provider.description)}
                </div>
              </div>
            </button>
          )
        }

        return (
          <div className="pt-4 border-t border-border-secondary space-y-4">
            {availablePresetProviders.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-text-secondary mb-3">
                  {t('Preset API')}
                </h4>
                <div className="space-y-2">
                  {availablePresetProviders.map(provider =>
                    renderProviderButton(provider, () => setAddingPresetProvider(provider))
                  )}
                </div>
              </div>
            )}
            {availableOAuthProviders.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-text-secondary mb-3">
                  {t('OAuth Login')}
                </h4>
                <div className="space-y-2">
                  {availableOAuthProviders.map(provider =>
                    renderProviderButton(
                      provider,
                      provider.type === CLI_DELEGATED_PROVIDER_ID
                        // Delegated sign-in has no OAuth flow to start: the CLI
                        // owns the credential, so the dialog only runs its login.
                        ? () => setDelegatedLoginOpen(true)
                        : () => oauth.start(provider.type)
                    )
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      <DelegatedLoginDialog
        open={delegatedLoginOpen}
        onClose={() => setDelegatedLoginOpen(false)}
        onComplete={async () => {
          await reloadConfig()
          setDelegatedLoginOpen(false)
        }}
      />
    </div>
  )
}
