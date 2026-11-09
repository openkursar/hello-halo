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
 * Model-agnostic entries (OpenAI / Anthropic protocol) carry no curated list:
 * an optional model ID field lets the user name one, and OpenAI-compatible
 * endpoints are resolved by a live fetch on save. Vendor presets keep their
 * static catalog. The user refines the model later in Settings / chat.
 *
 * Shares the provider catalog (`getApiKeyProviders`) and fetch/validate APIs
 * with `ProviderSelector`; only the layout is bespoke.
 */

import { useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { Eye, EyeOff, Loader2, CheckCircle2, XCircle, ExternalLink } from 'lucide-react'
import { api } from '../../api'
import { getBuiltinProvider, type AISource, type ModelOption, type ProviderId } from '../../types'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveLocalizedText, type ProviderDocsLink } from '../../../shared/types'
import { formatModelFetchError } from '../../utils/model-fetch-error'
import { createRequestGate } from '../../utils/request-gate'
import { ProviderCatalogDropdown } from '../ai-config/ProviderCatalogDropdown'
import {
  EMPTY_MODEL_FIELD,
  canBackfillTestedModel,
  onModelTyped,
  onTestSelected,
  withoutTestSelection,
  type ModelIdField
} from './model-field'

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
  const [modelField, setModelField] = useState<ModelIdField>(EMPTY_MODEL_FIELD)
  const modelId = modelField.value

  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; message?: string } | null>(null)
  /** A resolve/validate result may only land while its inputs are still current. */
  const requestGate = useRef(createRequestGate())

  const builtin = providerId ? getBuiltinProvider(providerId) : undefined
  const isAnthropic = providerId === 'anthropic' || builtin?.apiType === 'anthropic_passthrough'
  const staticModels = builtin?.models ?? []
  const canSubmit = Boolean(apiKey.trim() && providerId)

  const handleProviderChange = (id: ProviderId) => {
    requestGate.current.invalidate()
    setProviderId(id)
    setError(null)
    setValidationResult(null)
    const b = getBuiltinProvider(id)
    setApiUrl(b?.apiUrl || '')
    setModelField(EMPTY_MODEL_FIELD)
  }

  const handleApiKeyChange = (value: string) => {
    requestGate.current.invalidate()
    setApiKey(value)
    setError(null)
    setValidationResult(null)
    setModelField(withoutTestSelection)
  }

  // A tested model belongs to the endpoint that answered it; a typed one stays.
  const handleApiUrlChange = (value: string) => {
    requestGate.current.invalidate()
    setApiUrl(value)
    setError(null)
    setValidationResult(null)
    setModelField(withoutTestSelection)
  }

  const handleModelIdChange = (value: string) => {
    requestGate.current.invalidate()
    setModelField(onModelTyped(value))
    setError(null)
    setValidationResult(null)
  }

  // Resolve the model at save time. A typed model ID is an explicit statement
  // about the endpoint and wins. Otherwise an OpenAI-compatible gateway is
  // asked for its list; a vendor preset falls back to its curated catalog.
  //
  // A credential rejection is always returned as `fetchError` so the user
  // cannot enter the app with a broken key (#249). Other fetch failures are
  // tolerated when the user named a model: many compatible gateways do not
  // implement `/models` but serve chat just fine.
  const resolveModels = async (): Promise<{
    model: string
    availableModels: ModelOption[]
    fetchError?: string
  }> => {
    const typedModel = modelId.trim()
    let fetched: ModelOption[] = []

    if (!isAnthropic && apiKey.trim() && apiUrl) {
      try {
        const res = await api.fetchModels(apiKey.trim(), apiUrl)
        if (!res.success) {
          const message = formatModelFetchError(t, res.code, res.error)
          if (!typedModel || res.code === 'MODEL_FETCH_UNAUTHORIZED') {
            return { model: '', availableModels: staticModels, fetchError: message }
          }
        } else if (res.data) {
          fetched = (res.data as { models: ModelOption[] }).models
        }
      } catch {
        if (!typedModel) {
          return {
            model: '',
            availableModels: staticModels,
            fetchError: formatModelFetchError(t, 'MODEL_FETCH_NETWORK')
          }
        }
      }
    }

    if (typedModel) {
      return {
        model: typedModel,
        availableModels: fetched.some(model => model.id === typedModel)
          ? fetched
          : [{ id: typedModel, name: typedModel }, ...fetched]
      }
    }

    if (fetched.length > 0) {
      return { model: fetched[0].id, availableModels: fetched }
    }

    if (staticModels.length > 0) {
      return { model: staticModels[0].id, availableModels: staticModels }
    }

    return {
      model: '',
      availableModels: [],
      fetchError: isAnthropic
        ? t('Enter a model ID for this endpoint')
        : t('No models found at this endpoint. Enter a model ID or check the URL.')
    }
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

    const token = requestGate.current.begin()
    setError(null)
    setIsSaving(true)

    try {
      const { model, availableModels, fetchError } = await resolveModels()
      if (!requestGate.current.isCurrent(token)) {
        setError(t('Configuration changed — review and save again'))
        return
      }
      if (fetchError) {
        setError(fetchError)
        return
      }
      if (!model) {
        setError(t('Please select a model'))
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
      if (requestGate.current.isCurrent(token)) setError(t('Save failed'))
    } finally {
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

    const token = requestGate.current.begin()
    setError(null)
    setIsTesting(true)
    setValidationResult(null)

    try {
      const { model, fetchError } = await resolveModels()
      if (!requestGate.current.isCurrent(token)) return
      if (fetchError) {
        setValidationResult({ valid: false, message: fetchError })
        return
      }
      if (!model) {
        setValidationResult({ valid: false, message: t('Please select a model') })
        return
      }
      // Remember what was actually tested so Save cannot pick a different
      // model. A typed value stays the user's; only an empty/test value is
      // backfilled, and only where the field is visible.
      if (canBackfillTestedModel(staticModels.length > 0, modelField)) {
        setModelField(onTestSelected(model))
      }
      const result = await api.validateApi(apiKey.trim(), apiUrl, isAnthropic ? 'anthropic' : 'openai', model)
      if (!requestGate.current.isCurrent(token)) return

      if (!result.success || !result.data?.valid) {
        setValidationResult({ valid: false, message: result.data?.message || result.error || t('Connection failed') })
      } else {
        const normalizedUrl = result.data.normalizedUrl || apiUrl
        if (normalizedUrl !== apiUrl) setApiUrl(normalizedUrl)
        setValidationResult({ valid: true, message: t('Connection successful') })
      }
    } catch {
      if (!requestGate.current.isCurrent(token)) return
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
            onChange={(e) => handleApiKeyChange(e.target.value)}
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
          onChange={(e) => handleApiUrlChange(e.target.value)}
          placeholder="https://xxx.xxx.xxx"
          className="w-full px-4 py-2.5 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t('Auto-filled when you pick a provider; editable for a custom proxy')}
        </p>
      </div>

      {/* Protocol entries have no vendor catalog — let the user name a model.
          OpenAI-compatible endpoints can resolve one by fetching instead. */}
      {builtin && staticModels.length === 0 && (
        <div className="mb-2">
          <label className="block text-sm text-muted-foreground mb-2">{t('Model ID')}</label>
          <input
            type="text"
            value={modelId}
            onChange={(e) => handleModelIdChange(e.target.value)}
            placeholder={isAnthropic ? 'claude-sonnet-5' : t('Optional — fetched from the endpoint')}
            className="w-full px-4 py-2.5 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {isAnthropic
              ? t('Enter the model ID this endpoint serves.')
              : t('Optional. Leave blank to fetch the endpoint\u2019s model list and use its first model.')}
          </p>
        </div>
      )}

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
