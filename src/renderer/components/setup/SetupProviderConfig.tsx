/**
 * SetupProviderConfig — first-run chrome around a provider config form.
 *
 * Provides the setup wizard's logo/back/title chrome for a configurable auth
 * entry and persists the created source via `saveFirstRunSource`. The form it
 * wraps depends on the entry shape:
 *   - Preset gateway (`entry.preset`): the locked, API-key-only `ProviderSelector`
 *     panel (fixed baseUrl, provider switching hidden).
 *   - Custom API / BYOK (no preset): the key-first `CustomApiSetupForm`.
 */

import { useAppStore } from '../../stores/app.store'
import { ArrowLeft } from 'lucide-react'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { ProviderSelector } from '../settings/ProviderSelector'
import { CustomApiSetupForm } from './CustomApiSetupForm'
import { saveFirstRunSource } from './saveFirstRunSource'
import type { AISource, AISourcesConfig } from '../../types'
import { resolveLocalizedText, type AuthProviderConfig } from '../../../shared/types'

interface SetupProviderConfigProps {
  /** Auth entry driving the config form (preset gateway or Custom API/BYOK). */
  entry: AuthProviderConfig
  /** Return to the login method selection. */
  onBack: () => void
}

export function SetupProviderConfig({ entry, onBack }: SetupProviderConfigProps) {
  const { t } = useTranslation()
  const { config, setConfig, enterApp } = useAppStore()

  const title = resolveLocalizedText(entry.displayName, getCurrentLanguage())
  const isPreset = Boolean(entry.preset)

  // Persist the first source created during onboarding (shared with the login
  // screen's preset and custom paths).
  const handleSave = (source: AISource) => saveFirstRunSource(source, { config, setConfig, enterApp })

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

        {isPreset ? (
          <ProviderSelector
            aiSources={emptySources}
            onSave={handleSave}
            onCancel={onBack}
            presetProvider={entry}
          />
        ) : (
          <CustomApiSetupForm docs={entry.docs} onSave={handleSave} />
        )}
      </div>
    </div>
  )
}
