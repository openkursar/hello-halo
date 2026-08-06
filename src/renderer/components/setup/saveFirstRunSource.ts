/**
 * saveFirstRunSource — shared first-launch persistence for the setup wizard.
 *
 * Extracted from SetupProviderConfig so both entry paths that create the very
 * first AI source can persist it identically:
 *   - Preset gateway / Custom API config step (`SetupProviderConfig`)
 *   - The login screen's inline Custom-API form (`LoginSelector`)
 *
 * It writes the v2 `aiSources`, mirrors the legacy `config.api` field (read by
 * older code paths), clears `isFirstLaunch`, and enters the app.
 */

import { api } from '../../api'
import type { AISource, AISourcesConfig, HaloConfig, AppView } from '../../types'

interface FirstRunStore {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
  setView: (view: AppView) => void
}

export async function saveFirstRunSource(source: AISource, store: FirstRunStore): Promise<void> {
  const { config, setConfig, setView } = store

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
  setConfig(newConfig as HaloConfig)
  setView('home')
}
