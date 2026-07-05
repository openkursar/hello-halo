/**
 * API Setup - Custom API configuration
 * No validation - just save and enter, errors will show on first chat
 * Includes language selector for first-time users
 * Now supports back button for multi-source login flow
 */

import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useAppStore } from '../../stores/app.store'
import { api } from '../../api'
import { Lightbulb, CheckCircle2, XCircle } from '../icons/ToolIcons'
import { Globe, ChevronDown, ArrowLeft, Eye, EyeOff, Loader2, RefreshCw, ExternalLink } from 'lucide-react'
import { AVAILABLE_MODELS, DEFAULT_MODEL, type AISourcesConfig, type AISource, type ModelOption } from '../../types'
import { getBuiltinProvider } from '../../types'
import { resolveLocalizedText, type LocalizedText } from '../../../shared/types'
import { useTranslation, setLanguage, getCurrentLanguage, SUPPORTED_LOCALES, type LocaleCode } from '../../i18n'
import type { AuthProviderConfig } from './LoginSelector'
import { usePresetModels } from '../../hooks/usePresetModels'

interface ApiSetupProps {
  /** Called when user clicks back button */
  onBack?: () => void
  /** Whether to show the back button */
  showBack?: boolean
  /**
   * Preset-API provider entry. When set, the form switches to "API Key only"
   * mode: the provider toggle and apiUrl input are hidden, models are fetched
   * from `preset.baseUrl + (preset.modelsPath ?? '/v1/models')`, and the
   * persisted AISource records the configured `apiType`.
   */
  preset?: AuthProviderConfig
}

export function ApiSetup({ onBack, showBack = false, preset }: ApiSetupProps) {
  const { t } = useTranslation()
  const { config, setConfig, setView } = useAppStore()

  // Form state
  // In preset mode, the provider toggle is hidden and the baseUrl is fixed —
  // we still seed `provider` to a deterministic value ('openai') so that any
  // shared rendering paths (e.g. the model select block) keep behaving
  // consistently with the non-Anthropic branch.
  const [provider, setProvider] = useState(
    preset ? 'openai' : (config?.api.provider || 'anthropic')
  )
  const [apiKey, setApiKey] = useState(preset ? '' : (config?.api.apiKey || ''))
  const [apiUrl, setApiUrl] = useState(
    preset ? preset.preset!.baseUrl : (config?.api.apiUrl || 'https://api.anthropic.com')
  )
  // Initial model: prefer preset's first fallbackModel if available, else generic placeholder
  const [model, setModel] = useState(() => {
    if (preset) {
      const fallback = preset.preset!.fallbackModels
      return fallback && fallback.length > 0 ? fallback[0].id : ''
    }
    return config?.api.model || DEFAULT_MODEL
  })
  const [isValidating, setIsValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Validation result state
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    message?: string
  } | null>(null)
  // Custom model toggle (irrelevant in preset mode — preset always uses fetched/fallback list)
  const [useCustomModel, setUseCustomModel] = useState(() => {
    if (preset) return false
    const currentModel = config?.api.model || DEFAULT_MODEL
    return !AVAILABLE_MODELS.some(m => m.id === currentModel)
  })

  // Model fetching state. In preset mode the list lives as `ModelOption[]` so
  // we can preserve display names from `fallbackModels`. Non-preset mode keeps
  // the legacy `string[]` (model IDs only) to avoid touching that codepath.
  const [fetchedModels, setFetchedModels] = useState<string[]>(
    preset ? [] : ((config?.api.availableModels as string[]) || [])
  )
  const [isFetchingModels, setIsFetchingModels] = useState(false)

  // Preset mode delegates model fetching + race protection to the shared hook
  // (also used by ProviderSelector in settings). The hook is inert when
  // `enabled` is false, so non-preset flows pay no cost.
  const presetModelsHook = usePresetModels({
    baseUrl: preset?.preset?.baseUrl,
    modelsPath: preset?.preset?.modelsPath,
    fallbackModels: preset?.preset?.fallbackModels,
    apiKey,
    model,
    setModel,
    enabled: Boolean(preset)
  })
  const presetModels = presetModelsHook.models
  const isFetchingPresetModels = presetModelsHook.isFetching
  const presetWarning = presetModelsHook.warning

  // Language selector state
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false)
  const [currentLang, setCurrentLang] = useState<LocaleCode>(getCurrentLanguage())
  // API Key visibility
  const [showApiKey, setShowApiKey] = useState(false)

  // Handle language change
  const handleLanguageChange = (lang: LocaleCode) => {
    setLanguage(lang)
    setCurrentLang(lang)
    setIsLangDropdownOpen(false)
  }

  const handleProviderChange = (next: string) => {
    setProvider(next as any)
    setError(null)

    if (next === 'anthropic') {
      // Claude
      if (!apiUrl || apiUrl.includes('openai')) setApiUrl('https://api.anthropic.com')
      if (!model || !model.startsWith('claude-')) {
        setModel(DEFAULT_MODEL)
        setUseCustomModel(false)
      }
    } else if (next === 'openai') {
      // OpenAI compatible
      if (!apiUrl || apiUrl.includes('anthropic')) setApiUrl('https://api.openai.com')
      if (!model || model.startsWith('claude-')) setModel('gpt-4o-mini')
    }
  }

  // Fetch models from custom API (non-preset mode)
  const fetchModels = async () => {
    if (!apiUrl) {
      setError(t('Please enter API URL first'))
      return
    }
    if (!apiKey) {
      setError(t('Please enter API Key first'))
      return
    }

    setIsFetchingModels(true)
    setError(null)

    try {
      // Construct models endpoint
      let baseUrl = apiUrl
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1)

      // Remove /chat/completions suffix if present (common mistake)
      if (baseUrl.endsWith('/chat/completions')) {
        baseUrl = baseUrl.replace(/\/chat\/completions$/, '')
      }

      const url = `${baseUrl}/models`

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch models (${response.status})`)
      }

      const data = await response.json()

      // OpenAI compatible format: { data: [{ id: 'model-id', ... }] }
      if (data.data && Array.isArray(data.data)) {
        const models = data.data
          .map((m: any) => m.id)
          .filter((id: any) => typeof id === 'string')
          .sort()

        if (models.length === 0) {
          throw new Error('No models found in response')
        }

        setFetchedModels(models)

        // If current model is not in list (and we found models), select the first one?
        // Or just let user decide.
        // If current model is default generic one, maybe switch to first fetched.
        if (models.length > 0 && (!model || model === 'gpt-4o-mini' || model === 'deepseek-chat')) {
          setModel(models[0])
        }
      } else {
        throw new Error('Invalid API response format (expected data array)')
      }
    } catch {
      setError(t('Failed to fetch models. Check URL and Key.'))
    } finally {
      setIsFetchingModels(false)
    }
  }

  // Preset model fetching, race protection, fallback handling, and unmount
  // cleanup all live in the `usePresetModels` hook above. The hook returns a
  // `fetchModels()` function that we wire to the Fetch button.

  // Handle save and enter - save directly without mandatory validation
  const handleSaveAndEnter = async () => {
    if (!apiKey.trim()) {
      setError(t('Please enter API Key'))
      return
    }
    if (preset && !model) {
      setError(t('Please select a model'))
      return
    }

    setError(null)

    try {
      const now = new Date().toISOString()

      let newSource: AISource
      // legacy `config.api` mirror (kept for backward compatibility)
      let legacyProvider: 'anthropic' | 'openai'
      let legacyAvailableModels: string[]

      if (preset) {
        // ── Preset API source ─────────────────────────────────────────────
        const cfg = preset.preset!
        const availableModels: ModelOption[] = presetModels.length > 0
          ? presetModels
          : [{ id: model, name: model }]
        // Legacy 'provider' flag is best-effort: anthropic_passthrough maps to
        // 'anthropic' so the legacy code paths that read it (e.g. AdvancedSection)
        // still classify the source sensibly.
        legacyProvider = cfg.apiType === 'anthropic_passthrough' ? 'anthropic' : 'openai'
        legacyAvailableModels = availableModels.map(m => m.id)

        newSource = {
          id: uuidv4(),
          name: resolveLocalizedText(preset.displayName, getCurrentLanguage()),
          // Reuse the existing 'custom' provider bucket so the settings UI
          // (ProviderSelector / AISourcesSection) handles this source via the
          // standard API-key code paths without needing a new provider kind.
          provider: 'custom',
          authType: 'api-key',
          apiUrl: cfg.baseUrl,
          apiType: cfg.apiType,
          apiKey,
          model,
          availableModels,
          createdAt: now,
          updatedAt: now,
          // Explicit origin marker so the settings editor (ProviderSelector)
          // can render the preset-edit form for this source. Without this flag
          // the editor would fall back to the generic builtin-provider path,
          // which has no entry for `provider: 'custom'` and breaks the UI.
          isPreset: true
        }
      } else {
        // ── Custom API source (existing behavior, untouched) ──────────────
        const effectiveApiUrl = apiUrl || 'https://api.anthropic.com'
        const providerType = provider as 'anthropic' | 'openai'
        const builtin = getBuiltinProvider(providerType)
        legacyProvider = providerType
        legacyAvailableModels = fetchedModels

        newSource = {
          id: uuidv4(),
          name: builtin?.name || (providerType === 'anthropic' ? 'Claude API' : 'Custom API'),
          provider: providerType,
          authType: 'api-key',
          apiUrl: effectiveApiUrl,
          apiKey,
          model,
          availableModels: fetchedModels.length > 0
            ? fetchedModels.map(id => ({ id, name: id }))
            : builtin?.models || [{ id: model, name: model }],
          createdAt: now,
          updatedAt: now
        }
      }

      // Build v2 aiSources config
      const newAiSources: AISourcesConfig = {
        version: 2,
        currentId: newSource.id,
        sources: [newSource]
      }

      const newConfig = {
        ...config,
        // Legacy api field for backward compatibility
        api: {
          provider: legacyProvider,
          apiKey,
          apiUrl: newSource.apiUrl,
          model,
          availableModels: legacyAvailableModels
        },
        // v2 aiSources structure
        aiSources: newAiSources,
        isFirstLaunch: false
      }

      await api.setConfig(newConfig)
      setConfig(newConfig as any)

      // Enter Halo
      setView('home')
    } catch {
      setError(t('Save failed'))
    }
  }

  // Optional: test API connection without blocking save
  const handleTestConnection = async () => {
    if (!apiKey.trim()) {
      setError(t('Please enter API Key'))
      return
    }

    setIsValidating(true)
    setError(null)
    setValidationResult(null)

    try {
      const effectiveApiUrl = apiUrl || 'https://api.anthropic.com'
      const result = await api.validateApi(apiKey, effectiveApiUrl, provider, model)

      if (!result.success || !result.data?.valid) {
        setValidationResult({
          valid: false,
          message: result.data?.message || result.error || t('Connection failed')
        })
      } else {
        // Auto-correct URL if backend normalized it
        const normalizedUrl = result.data.normalizedUrl || effectiveApiUrl
        if (normalizedUrl !== apiUrl) {
          setApiUrl(normalizedUrl)
        }
        setValidationResult({ valid: true, message: t('Connection successful') })
      }
    } catch {
      setValidationResult({
        valid: false,
        message: t('Connection failed')
      })
    } finally {
      setIsValidating(false)
    }
  }

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background p-8 relative overflow-auto">
      {/* Language Selector - Top Right */}
      <div className="absolute top-6 right-6">
        <div className="relative">
          <button
            onClick={() => setIsLangDropdownOpen(!isLangDropdownOpen)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <Globe className="w-4 h-4" />
            <span>{SUPPORTED_LOCALES[currentLang]}</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${isLangDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Dropdown */}
          {isLangDropdownOpen && (
            <>
              {/* Backdrop to close dropdown */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setIsLangDropdownOpen(false)}
              />
              <div className="absolute right-0 mt-1 py-1 w-40 bg-card border border-border rounded-lg shadow-lg z-20">
                {Object.entries(SUPPORTED_LOCALES).map(([code, name]) => (
                  <button
                    key={code}
                    onClick={() => handleLanguageChange(code as LocaleCode)}
                    className={`w-full px-4 py-2 text-left text-sm hover:bg-secondary/80 transition-colors ${currentLang === code ? 'text-primary font-medium' : 'text-foreground'
                      }`}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="flex flex-col items-center mb-8">
        {/* Logo */}
        <div className="w-16 h-16 rounded-full border-2 border-primary/60 flex items-center justify-center halo-glow">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
        </div>
        <h1 className="mt-4 text-2xl font-light">Halo</h1>
      </div>

      {/* Main content */}
      <div className="w-full max-w-md">
        <div className="relative mb-6">
          {/* Back Button - inline left of title */}
          {showBack && onBack && (
            <button
              onClick={onBack}
              className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>{t('Back')}</span>
            </button>
          )}
          <h2 className="text-center text-lg">
            {preset
              ? resolveLocalizedText(preset.displayName, getCurrentLanguage())
              : (showBack ? t('Configure Custom API') : t('Before you start, configure your AI'))}
          </h2>
        </div>

        <div className="bg-card rounded-xl p-6 border border-border">
          {/* Provider — hidden in preset mode (baseUrl + apiType are fixed) */}
          {!preset && (
            <div className="mb-4 flex items-center justify-between gap-3 p-3 bg-secondary/50 rounded-lg">
              <div className="w-8 h-8 rounded-lg bg-[#da7756]/20 flex items-center justify-center">
                <svg className="w-5 h-5 text-[#da7756]" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M4.709 15.955l4.72-2.647.08-.08 2.726-1.529.08-.08 6.206-3.48a.25.25 0 00.125-.216V6.177a.25.25 0 00-.375-.217l-6.206 3.48-.08.08-2.726 1.53-.08.079-4.72 2.647a.25.25 0 00-.125.217v1.746c0 .18.193.294.354.216h.001zm13.937-3.584l-4.72 2.647-.08.08-2.726 1.529-.08.08-6.206 3.48a.25.25 0 00-.125.216v1.746a.25.25 0 00.375.217l6.206-3.48.08-.08 2.726-1.53.08-.079 4.72-2.647a.25.25 0 00.125-.217v-1.746a.25.25 0 00-.375-.216z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-sm">
                  {provider === 'anthropic'
                    ? t('Claude (Anthropic) API')
                    : t('OpenAI API')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {provider === 'openai'
                    ? t('Official and all compatible providers')
                    : t('Official and compatible proxies')}
                </p>
              </div>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors text-sm"
              >
                <option value="anthropic">{t('Claude (Anthropic) API')}</option>
                <option value="openai">{t('OpenAI API')}</option>
              </select>
            </div>
          )}

          {/* Preset description (replaces provider toggle) */}
          {preset && (
            <div className="mb-4 p-3 bg-secondary/50 rounded-lg">
              <p className="text-xs text-muted-foreground">
                {resolveLocalizedText(preset.description, getCurrentLanguage())}
              </p>
            </div>
          )}

          {/* API Key input */}
          <div className={preset ? 'mb-2' : 'mb-4'}>
            <label className="block text-sm text-muted-foreground mb-2">API Key</label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={preset ? '••••••••••••' : (provider === 'openai' ? 'sk-xxxxxxxxxxxxx' : 'sk-ant-xxxxxxxxxxxxx')}
                className="w-full px-4 py-2 pr-12 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Docs link (preset mode only) */}
          {preset?.preset?.docs && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => { void api.openExternal(preset.preset!.docs!.url) }}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="w-3 h-3" />
                {preset.preset.docs.label
                  ? resolveLocalizedText(preset.preset.docs.label as LocalizedText, getCurrentLanguage())
                  : t('Learn more')}
              </button>
            </div>
          )}

          {/* API URL input — hidden in preset mode */}
          {!preset && (
            <div className="mb-6">
              <label className="block text-sm text-muted-foreground mb-2">{t('API URL (optional)')}</label>
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder={provider === 'openai' ? 'https://api.openai.com or https://xx/v1' : 'https://api.anthropic.com'}
                className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {provider === 'openai'
                  ? t('Enter OpenAI compatible service URL (supports /v1/chat/completions)')
                  : t('Default official URL, modify for custom proxy')}
              </p>
            </div>
          )}

          {/* Model */}
          <div className="mb-2">
            <label className="block text-sm text-muted-foreground mb-2">{t('Model')}</label>
            {preset ? (
              <>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    {presetModels.length > 0 ? (
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors appearance-none"
                      >
                        {!presetModels.some(m => m.id === model) && model && (
                          <option value={model}>{model}</option>
                        )}
                        {presetModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name || m.id}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="w-full px-4 py-2 bg-input rounded-lg border border-border text-sm text-muted-foreground">
                        {t('Enter API Key, then fetch models')}
                      </div>
                    )}
                    {presetModels.length > 0 && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => { void presetModelsHook.fetchModels() }}
                    disabled={isFetchingPresetModels || !apiKey.trim()}
                    className="px-3 py-2 bg-secondary hover:bg-secondary/80 text-foreground rounded-lg border border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('Fetch available models')}
                  >
                    <RefreshCw className={`w-4 h-4 ${isFetchingPresetModels ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                {presetWarning && (
                  <p className="mt-2 text-xs text-yellow-600 dark:text-yellow-500">
                    {presetWarning}
                  </p>
                )}
                {!presetWarning && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('Models will be fetched from the gateway after you enter an API Key')}
                  </p>
                )}
              </>
            ) : provider === 'anthropic' ? (
              <>
                {useCustomModel ? (
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={DEFAULT_MODEL}
                    className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                  />
                ) : (
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                  >
                    {AVAILABLE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                )}
                <div className="mt-1 flex items-center justify-between gap-4">
                  <span className="text-xs text-muted-foreground">
                    {useCustomModel
                      ? t('Enter official Claude model name')
                      : t(AVAILABLE_MODELS.find((m) => m.id === model)?.description || '')}
                  </span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground/70 cursor-pointer hover:text-muted-foreground transition-colors whitespace-nowrap shrink-0">
                    <input
                      type="checkbox"
                      checked={useCustomModel}
                      onChange={(e) => {
                        setUseCustomModel(e.target.checked)
                        if (!e.target.checked && !AVAILABLE_MODELS.some(m => m.id === model)) {
                          setModel(DEFAULT_MODEL)
                        }
                      }}
                      className="w-3 h-3 rounded border-border"
                    />
                    {t('Custom')}
                  </label>
                </div>
              </>
            ) : (
              <>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    {fetchedModels.length > 0 ? (
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors appearance-none"
                      >
                        {/* Ensure current model is an option even if not in fetched list (e.g. manual entry previously) */}
                        {!fetchedModels.includes(model) && model && (
                          <option value={model}>{model}</option>
                        )}
                        {fetchedModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="gpt-4o-mini / deepseek-chat"
                        className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                      />
                    )}
                    {/* Chevron for select */}
                    {fetchedModels.length > 0 && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground">
                        <ChevronDown className="w-4 h-4" />
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={fetchModels}
                    disabled={isFetchingModels || !apiKey || !apiUrl}
                    className="px-3 py-2 bg-secondary hover:bg-secondary/80 text-foreground rounded-lg border border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('Fetch available models')}
                  >
                    <RefreshCw className={`w-4 h-4 ${isFetchingModels ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Enter OpenAI compatible service model name')}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Help link — hidden in preset mode (preset.docs link lives inside the card) */}
        {!preset && (
          <p className="text-center mt-4 text-sm text-muted-foreground">
            <a
              href="https://console.anthropic.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary cursor-pointer hover:underline inline-flex items-center gap-1"
            >
              <Lightbulb className="w-4 h-4 text-yellow-500" />
              {t("Don't know how to get it? View tutorial")}
            </a>
          </p>
        )}

        {/* Error message */}
        {error && (
          <p className="text-center mt-4 text-sm text-red-500">{error}</p>
        )}

        {/* Validation result */}
        {validationResult && (
          <div className={`mt-4 p-3 rounded-lg ${validationResult.valid ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
            <p className={`text-sm flex items-center gap-2 ${validationResult.valid ? 'text-green-500' : 'text-red-500'}`}>
              {validationResult.valid ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
              <span>{validationResult.message}</span>
            </p>
          </div>
        )}

        {/* Buttons */}
        <div className="mt-6 flex flex-col sm:flex-row gap-3">
          {/* Test connection is custom-API only — preset mode validates via the model fetch */}
          {!preset && (
            <button
              onClick={handleTestConnection}
              disabled={isValidating}
              className="px-4 py-3 bg-secondary text-foreground rounded-lg border border-border hover:bg-secondary/80 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 whitespace-nowrap"
            >
              {isValidating && <Loader2 className="w-4 h-4 animate-spin" />}
              {isValidating ? t('Testing...') : t('Test connection')}
            </button>
          )}
          <button
            onClick={handleSaveAndEnter}
            disabled={isValidating}
            className="flex-1 px-8 py-3 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {t('Save and enter')}
          </button>
        </div>
      </div>
    </div>
  )
}
