/**
 * CustomApiSetupForm — first-run "Custom API" (BYOK) configuration.
 *
 * Implements the onboarding design's key-first flow, deliberately different
 * from the Settings provider editor (`ProviderSelector`):
 *   1. API Key sits on top, with the login entry's optional tutorial link.
 *   2. Provider is chosen *after*, from the full catalog, with NO default — the
 *      user must actively pick ("Select provider"), reinforcing the "enter your
 *      key, then tell us whose key it is" mental model.
 *   3. API URL auto-fills from the chosen provider and stays editable.
 *
 * No model picker is shown: the model list is resolved on save (live fetch for
 * OpenAI-compatible providers, static catalog otherwise) and the first model is
 * selected automatically. The user refines the model later in Settings / chat.
 *
 * Shares the provider catalog (`getApiKeyProviders`) and fetch/validate APIs
 * with `ProviderSelector`; only the layout is bespoke.
 */

import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { Eye, EyeOff, Loader2, CheckCircle2, XCircle, ExternalLink } from 'lucide-react'
import { api } from '../../api'
import { getBuiltinProvider, type AISource, type ModelOption, type ProviderId } from '../../types'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveLocalizedText, type ProviderDocsLink } from '../../../shared/types'
import { formatModelFetchError } from '../../utils/model-fetch-error'
import { ProviderCatalogDropdown } from '../ai-config/ProviderCatalogDropdown'

interface CustomApiSetupFormProps {
  /** Optional tutorial link from the login entry (e.g. "how to get a key"). */
  docs?: ProviderDocsLink
  /** Persist the built source and enter the app (owns the legacy mirror). */
  onSave: (source: AISource) => Promise<void>
}

export function CustomApiSetupForm({ docs, onSave }: CustomApiSetupFormProps) {
  const { t } = useTranslation()

  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [providerId, setProviderId] = useState<ProviderId | ''>('')
  const [apiUrl, setApiUrl] = useState('')

  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; message?: string } | null>(null)

  const builtin = providerId ? getBuiltinProvider(providerId) : undefined
  const isAnthropic = providerId === 'anthropic' || builtin?.apiType === 'anthropic_passthrough'
  const canSubmit = Boolean(apiKey.trim() && providerId)

  const handleProviderChange = (id: ProviderId) => {
    setProviderId(id)
    setError(null)
    setValidationResult(null)
    const b = getBuiltinProvider(id)
    setApiUrl(b?.apiUrl || '')
  }

  // Resolve the model list at save time: live fetch for OpenAI-compatible
  // gateways, falling back to the provider's static catalog. Anthropic always
  // uses its static list.
  //
  // A genuine fetch failure (bad key, auth, unreachable gateway) is returned as
  // `fetchError` so the caller can surface why (#249) instead of letting the
  // user enter the app with a broken credential. A successful-but-empty list
  // still degrades silently to the static catalog — some gateways expose no
  // `/models` endpoint, and blocking onboarding on that would be wrong.
  const resolveModels = async (): Promise<{
    model: string
    availableModels: ModelOption[]
    fetchError?: string
  }> => {
    const fallback = builtin?.models ?? []
    const staticList = () => {
      const model = fallback[0]?.id || ''
      const availableModels = fallback.length > 0
        ? fallback
        : (model ? [{ id: model, name: model }] : [])
      return { model, availableModels }
    }

    if (!isAnthropic && apiKey.trim() && apiUrl) {
      try {
        const res = await api.fetchModels(apiKey.trim(), apiUrl)
        if (!res.success) {
          return { ...staticList(), fetchError: formatModelFetchError(t, res.code, res.error) }
        }
        if (res.data) {
          const { models } = res.data as { models: ModelOption[] }
          if (models.length > 0) {
            return { model: models[0].id, availableModels: models }
          }
        }
      } catch {
        return { ...staticList(), fetchError: formatModelFetchError(t, 'MODEL_FETCH_NETWORK') }
      }
    }

    return staticList()
  }

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError(t('Please enter API Key'))
      return
    }
    if (!providerId || !builtin) {
      setError(t('Please select a provider'))
      return
    }

    setError(null)
    setIsSaving(true)

    try {
      const { model, availableModels, fetchError } = await resolveModels()
      if (fetchError) {
        setError(fetchError)
        setIsSaving(false)
        return
      }
      const now = new Date().toISOString()

      const source: AISource = {
        id: uuidv4(),
        name: t(builtin.name),
        provider: providerId,
        authType: 'api-key',
        apiUrl,
        apiType: builtin.apiType,
        apiKey: apiKey.trim(),
        model,
        availableModels,
        createdAt: now,
        updatedAt: now
      }

      await onSave(source)
    } catch {
      setError(t('Save failed'))
      setIsSaving(false)
    }
  }

  const handleTestConnection = async () => {
    if (!apiKey.trim()) {
      setError(t('Please enter API Key'))
      return
    }
    if (!providerId || !builtin) {
      setError(t('Please select a provider'))
      return
    }

    setError(null)
    setIsTesting(true)
    setValidationResult(null)

    try {
      const model = builtin.models[0]?.id
      const result = await api.validateApi(apiKey.trim(), apiUrl, isAnthropic ? 'anthropic' : 'openai', model)

      if (!result.success || !result.data?.valid) {
        setValidationResult({ valid: false, message: result.data?.message || result.error || t('Connection failed') })
      } else {
        const normalizedUrl = result.data.normalizedUrl || apiUrl
        if (normalizedUrl !== apiUrl) setApiUrl(normalizedUrl)
        setValidationResult({ valid: true, message: t('Connection successful') })
      }
    } catch {
      setValidationResult({ valid: false, message: t('Connection failed') })
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <div className="bg-card rounded-xl p-6 border border-border">
      {/* API Key — first, per the key-first onboarding flow */}
      <div className="mb-4">
        <label className="block text-sm text-muted-foreground mb-2">API Key</label>
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('Enter your API Key')}
            className="w-full px-4 py-2.5 pr-12 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {docs && (
          <button
            type="button"
            onClick={() => { void api.openExternal(docs.url) }}
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {docs.label
              ? resolveLocalizedText(docs.label, getCurrentLanguage())
              : t("Don't know how to get it? View tutorial")}
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Provider — no default; the user must actively choose. Shares the same
          searchable dropdown component as the Settings provider editor. */}
      <div className="mb-4">
        <label className="block text-sm text-muted-foreground mb-2">{t('Provider')}</label>
        <ProviderCatalogDropdown value={providerId} onChange={handleProviderChange} />
      </div>

      {/* API URL — auto-filled from the provider, editable for custom proxies */}
      <div className="mb-2">
        <label className="block text-sm text-muted-foreground mb-2">API URL</label>
        <input
          type="text"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://xxx.xxx.xxx"
          className="w-full px-4 py-2.5 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t('Auto-filled when you pick a provider; editable for a custom proxy')}
        </p>
      </div>

      {/* Error message */}
      {error && (
        <p className="mt-3 text-sm text-red-500">{error}</p>
      )}

      {/* Validation result */}
      {validationResult && (
        <div className={`mt-3 p-3 rounded-lg ${validationResult.valid ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
          <p className={`text-sm flex items-center gap-2 ${validationResult.valid ? 'text-green-500' : 'text-red-500'}`}>
            {validationResult.valid ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
            <span>{validationResult.message}</span>
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <button
          onClick={handleTestConnection}
          disabled={isTesting || isSaving || !canSubmit}
          className="flex-1 px-4 py-3 bg-secondary text-foreground rounded-lg border border-border hover:bg-secondary/80 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 whitespace-nowrap"
        >
          {isTesting && <Loader2 className="w-4 h-4 animate-spin" />}
          {isTesting ? t('Testing...') : t('Test connection')}
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving || isTesting || !canSubmit}
          className="flex-1 px-8 py-3 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          {t('Save and enter')}
        </button>
      </div>
    </div>
  )
}
