/**
 * SetupProviderConfig — first-run chrome around the preset-gateway config form.
 *
 * Provides the setup wizard's logo/back/title chrome for a preset-API entry and
 * persists the created source via `saveFirstRunSource`. Renders `ProviderSelector`
 * in its locked, API-key-only preset panel (the same form Settings uses to add a
 * preset source).
 *
 * The Custom API (BYOK) path is handled inline on the login screen
 * (`LoginSelector` → `CustomApiSetupForm`), not here.
 */

import { useAppStore } from '../../stores/app.store'
import { ArrowLeft } from 'lucide-react'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { ProviderSelector } from '../settings/ProviderSelector'
import { saveFirstRunSource } from './saveFirstRunSource'
import type { AISource, AISourcesConfig } from '../../types'
import { resolveLocalizedText, type AuthProviderConfig } from '../../../shared/types'

interface SetupProviderConfigProps {
  /** Preset-API entry driving the locked API-key form. */
  presetProvider: AuthProviderConfig
  /** Return to the login method selection. */
  onBack: () => void
}

export function SetupProviderConfig({ presetProvider, onBack }: SetupProviderConfigProps) {
  const { t } = useTranslation()
  const { config, setConfig, setView } = useAppStore()

  const title = resolveLocalizedText(presetProvider.displayName, getCurrentLanguage())

  // Persist the first source created during onboarding (shared with the login
  // screen's inline Custom-API path).
  const handleSave = (source: AISource) => saveFirstRunSource(source, { config, setConfig, setView })

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

        <ProviderSelector
          aiSources={emptySources}
          onSave={handleSave}
          onCancel={onBack}
          presetProvider={presetProvider}
        />
      </div>
    </div>
  )
}
