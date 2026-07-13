/**
 * SetupProviderConfig — first-run chrome around the provider config form.
 *
 * Provides the setup wizard's logo/back/title chrome and owns the first-launch
 * persistence: it mirrors the saved source into the legacy `config.api` field,
 * writes the v2 `aiSources`, clears `isFirstLaunch`, and enters the app.
 *
 * Two modes use two different forms (same persistence):
 *   - Custom API (BYOK): `CustomApiSetupForm` — the key-first onboarding layout.
 *   - Preset gateway: `ProviderSelector` in its locked, API-key-only preset
 *     panel (the same form Settings uses to add a preset source).
 */

import { useAppStore } from '../../stores/app.store'
import { api } from '../../api'
import { ArrowLeft } from 'lucide-react'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { ProviderSelector } from '../settings/ProviderSelector'
import { CustomApiSetupForm } from './CustomApiSetupForm'
import type { AISource, AISourcesConfig } from '../../types'
import { resolveLocalizedText, type AuthProviderConfig } from '../../../shared/types'

interface SetupProviderConfigProps {
  /** Preset-API entry. When set, the form runs in locked preset mode. */
  presetProvider?: AuthProviderConfig
  /** API key carried over from the login screen's inline Custom-API entry. */
  initialApiKey?: string
  /** Return to the login method selection. */
  onBack: () => void
}

export function SetupProviderConfig({ presetProvider, initialApiKey, onBack }: SetupProviderConfigProps) {
  const { t } = useTranslation()
  const { config, setConfig, setView } = useAppStore()

  const title = presetProvider
    ? resolveLocalizedText(presetProvider.displayName, getCurrentLanguage())
    : t('Configure Custom API')

  // Persist the first source created during onboarding. Mirrors the legacy
  // `config.api` field (read by older code paths) alongside the v2 aiSources.
  const handleSave = async (source: AISource) => {
    const legacyProvider: 'anthropic' | 'openai' =
      source.apiType === 'anthropic_passthrough' || source.provider === 'anthropic'
        ? 'anthropic'
        : 'openai'

    const aiSources: AISourcesConfig = {
      version: 2,
      currentId: source.id,
      sources: [source]
    }

    const newConfig = {
      ...config,
      api: {
        provider: legacyProvider,
        apiKey: source.apiKey,
        apiUrl: source.apiUrl,
        model: source.model,
        availableModels: source.availableModels.map(m => m.id)
      },
      aiSources,
      isFirstLaunch: false
    }

    await api.setConfig(newConfig)
    setConfig(newConfig as any)
    setView('home')
  }

  const emptySources: AISourcesConfig = config?.aiSources ?? {
    version: 2,
    currentId: null,
    sources: []
  }

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background p-4 sm:p-8 relative overflow-auto">
      {/* Header */}
      <div className="flex flex-col items-center mb-6 sm:mb-8">
        <div className="w-16 h-16 rounded-full border-2 border-primary/60 flex items-center justify-center halo-glow">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
        </div>
        <h1 className="mt-4 text-2xl font-light">Halo</h1>
      </div>

      <div className="w-full max-w-md">
        {/* Title row with back button */}
        <div className="relative mb-6">
          <button
            onClick={onBack}
            className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            <span>{t('Back')}</span>
          </button>
          <h2 className="text-center text-lg">{title}</h2>
        </div>

        {presetProvider ? (
          <ProviderSelector
            aiSources={emptySources}
            onSave={handleSave}
            onCancel={onBack}
            presetProvider={presetProvider}
          />
        ) : (
          <CustomApiSetupForm
            initialApiKey={initialApiKey}
            onSave={handleSave}
          />
        )}
      </div>
    </div>
  )
}
