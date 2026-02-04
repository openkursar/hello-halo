/**
 * ProviderSelector - Built-in Provider Selection Component (v2 UX)
 *
 * Searchable dropdown to select LLM provider, with configuration form.
 *
 * Features:
 * - Searchable dropdown with grouped providers (Recommended + All)
 * - API key input for selected provider
 * - Model selection with search and fetch capability
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import {
  ChevronDown, Search, Check, Loader2, Eye, EyeOff, ExternalLink, X, Star
} from 'lucide-react'
import type {
  AISource,
  AISourcesConfig,
  ProviderId,
  ModelOption,
  BuiltinProvider
} from '../../types'
import {
  getBuiltinProvider,
  getApiKeyProviders,
  isAnthropicProvider
} from '../../types'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

interface ProviderSelectorProps {
  aiSources: AISourcesConfig
  onSave: (source: AISource) => Promise<void>
  onCancel: () => void
  editingSourceId?: string | null
}

export function ProviderSelector({
  aiSources,
  onSave,
  onCancel,
  editingSourceId
}: ProviderSelectorProps) {
  const { t } = useTranslation()
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Get the source being edited (if any)
  const editingSource = editingSourceId
    ? aiSources.sources.find(s => s.id === editingSourceId)
    : null

  // Get all API key providers
  const allProviders = useMemo(() => getApiKeyProviders(), [])
  const recommendedProviders = useMemo(() => allProviders.filter(p => p.recommended), [allProviders])
  const otherProviders = useMemo(() => allProviders.filter(p => !p.recommended), [allProviders])

  // State
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(
    editingSource?.provider || 'anthropic'
  )
  const [showProviderDropdown, setShowProviderDropdown] = useState(false)
  const [providerSearchQuery, setProviderSearchQuery] = useState('')

  const [apiKey, setApiKey] = useState(editingSource?.apiKey || '')
  const [apiUrl, setApiUrl] = useState(editingSource?.apiUrl || '')
  const [selectedModel, setSelectedModel] = useState(editingSource?.model || '')
  const [customModelInput, setCustomModelInput] = useState('')
  const [showCustomModel, setShowCustomModel] = useState(false)
  const [sourceName, setSourceName] = useState(editingSource?.name || '')

  const [showApiKey, setShowApiKey] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    message?: string
  } | null>(null)

  const [fetchedModels, setFetchedModels] = useState<ModelOption[]>(
    editingSource?.availableModels || []
  )
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [showModelDropdown, setShowModelDropdown] = useState(false)

  // Get current provider config
  const currentProvider = useMemo(() =>
    getBuiltinProvider(selectedProvider),
    [selectedProvider]
  )

  // Filter providers by search
  const filteredRecommended = useMemo(() => {
    if (!providerSearchQuery) return recommendedProviders
    const q = providerSearchQuery.toLowerCase()
    return recommendedProviders.filter(p =>
      p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    )
  }, [recommendedProviders, providerSearchQuery])

  const filteredOthers = useMemo(() => {
    if (!providerSearchQuery) return otherProviders
    const q = providerSearchQuery.toLowerCase()
    return otherProviders.filter(p =>
      p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    )
  }, [otherProviders, providerSearchQuery])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showProviderDropdown) return

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowProviderDropdown(false)
        setProviderSearchQuery('')
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showProviderDropdown])

  // Update form when provider changes
  useEffect(() => {
    if (currentProvider && !editingSource) {
      setApiUrl(currentProvider.apiUrl)
      setSelectedModel(currentProvider.models[0]?.id || '')
      setSourceName(currentProvider.name)
      setFetchedModels(currentProvider.models)
    }
  }, [selectedProvider, currentProvider, editingSource])

  // Filter models by search query
  const filteredModels = useMemo(() => {
    const models = fetchedModels.length > 0 ? fetchedModels : (currentProvider?.models || [])
    if (!modelSearchQuery) return models
    const query = modelSearchQuery.toLowerCase()
    return models.filter(m =>
      m.id.toLowerCase().includes(query) ||
      m.name.toLowerCase().includes(query)
    )
  }, [fetchedModels, currentProvider?.models, modelSearchQuery])

  // Handle provider selection
  const handleSelectProvider = (providerId: ProviderId) => {
    setSelectedProvider(providerId)
    setApiKey('')
    setValidationResult(null)
    setFetchedModels([])
    setShowCustomModel(false)
    setCustomModelInput('')
    setShowProviderDropdown(false)
    setProviderSearchQuery('')
  }

  // Handle delete model from list
  const handleDeleteModel = (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const models = fetchedModels.length > 0 ? fetchedModels : (currentProvider?.models || [])
    const newModels = models.filter(m => m.id !== modelId)
    setFetchedModels(newModels)

    // If deleted model was selected, switch to first available
    if (selectedModel === modelId && newModels.length > 0) {
      setSelectedModel(newModels[0].id)
    }
  }

  // Check if model can be deleted
  // Rules: only allow deletion when there are user-fetched/edited models AND more than 1 model
  const canDeleteModel = (): boolean => {
    // Only allow deletion if we have fetched models (user-added, not provider defaults)
    // and there's more than 1 model (keep at least one)
    return fetchedModels.length > 1
  }

  // Fetch models from API
  const handleFetchModels = async () => {
    if (!apiKey || !apiUrl) {
      setValidationResult({ valid: false, message: t('Please enter API Key and URL first') })
      return
    }

    setIsFetchingModels(true)
    setValidationResult(null)

    try {
      let baseUrl = apiUrl.replace(/\/+$/, '')
      const suffixes = ['/chat/completions', '/completions', '/responses', '/v1/chat']
      for (const suffix of suffixes) {
        if (baseUrl.endsWith(suffix)) {
          baseUrl = baseUrl.slice(0, -suffix.length)
          break
        }
      }

      if (!baseUrl.includes('/v1') && !baseUrl.includes('/api/paas')) {
        baseUrl = `${baseUrl}/v1`
      }

      const modelsUrl = `${baseUrl}/models`

      const response = await fetch(modelsUrl, {
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

      if (data.data && Array.isArray(data.data)) {
        const models: ModelOption[] = data.data
          .filter((m: any) => typeof m.id === 'string')
          .map((m: any) => ({ id: m.id, name: m.id }))
          .sort((a: ModelOption, b: ModelOption) => a.id.localeCompare(b.id))

        if (models.length === 0) {
          throw new Error('No models found')
        }

        setFetchedModels(models)

        if (!selectedModel || !models.some(m => m.id === selectedModel)) {
          setSelectedModel(models[0].id)
        }

        setValidationResult({ valid: true, message: t('Found ${count} models').replace('${count}', String(models.length)) })
      } else {
        throw new Error('Invalid API response format')
      }
    } catch (error) {
      console.error('[ProviderSelector] Failed to fetch models:', error)
      setValidationResult({ valid: false, message: t('Failed to fetch models') })
    } finally {
      setIsFetchingModels(false)
    }
  }

  // Handle save (direct save without validation)
  const handleSave = async () => {
    if (!apiKey) {
      setValidationResult({ valid: false, message: t('Please enter API Key') })
      return
    }

    const finalModel = showCustomModel && customModelInput ? customModelInput : selectedModel

    if (!finalModel) {
      setValidationResult({ valid: false, message: t('Please select a model') })
      return
    }

    setIsValidating(true)
    setValidationResult(null)

    try {
      const availableModels: ModelOption[] = fetchedModels.length > 0
        ? fetchedModels
        : (currentProvider?.models || [{ id: finalModel, name: finalModel }])

      if (!availableModels.some(m => m.id === finalModel)) {
        availableModels.unshift({ id: finalModel, name: finalModel })
      }

      const now = new Date().toISOString()

      const source: AISource = {
        id: editingSource?.id || uuidv4(),
        name: sourceName || currentProvider?.name || selectedProvider,
        provider: selectedProvider,
        authType: 'api-key',
        apiUrl: apiUrl || currentProvider?.apiUrl || 'https://api.openai.com',
        apiType: editingSource?.apiType || currentProvider?.apiType,
        apiKey,
        model: finalModel,
        availableModels,
        createdAt: editingSource?.createdAt || now,
        updatedAt: now
      }

      await onSave(source)

      setValidationResult({ valid: true, message: t('Saved') })
    } catch (error) {
      console.error('[ProviderSelector] Save failed:', error)
      setValidationResult({ valid: false, message: t('Save failed') })
    } finally {
      setIsValidating(false)
    }
  }

  // Handle test connection (optional validation)
  const handleTestConnection = async () => {
    if (!apiKey) {
      setValidationResult({ valid: false, message: t('Please enter API Key') })
      return
    }

    const finalModel = showCustomModel && customModelInput ? customModelInput : selectedModel

    setIsValidating(true)
    setValidationResult(null)

    try {
      const validationResponse = await api.validateApi(
        apiKey,
        apiUrl,
        isAnthropicProvider(selectedProvider) ? 'anthropic' : 'openai',
        finalModel
      )

      if (!validationResponse.success || !validationResponse.data?.valid) {
        setValidationResult({
          valid: false,
          message: validationResponse.data?.message || validationResponse.error || t('Connection failed')
        })
      } else {
        const normalizedUrl = validationResponse.data.normalizedUrl || apiUrl
        if (normalizedUrl !== apiUrl) {
          setApiUrl(normalizedUrl)
        }
        setValidationResult({ valid: true, message: t('Connection successful') })
      }
    } catch (error) {
      console.error('[ProviderSelector] Test failed:', error)
      setValidationResult({ valid: false, message: t('Connection failed') })
    } finally {
      setIsValidating(false)
    }
  }

  // Render provider item in dropdown
  const renderProviderItem = (provider: BuiltinProvider, showRecommended = false) => (
    <button
      key={provider.id}
      onClick={() => handleSelectProvider(provider.id)}
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/80 transition-colors ${
        selectedProvider === provider.id ? 'bg-primary/10' : ''
      }`}
    >
      {/* Provider Icon/Initial */}
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
        selectedProvider === provider.id ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'
      }`}>
        <span className="text-sm font-bold">{provider.name.charAt(0)}</span>
      </div>

      {/* Provider Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{provider.name}</span>
          {showRecommended && provider.recommended && (
            <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
          )}
        </div>
        {provider.description && (
          <div className="text-xs text-muted-foreground truncate">{provider.description}</div>
        )}
      </div>

      {/* Check mark */}
      {selectedProvider === provider.id && (
        <Check className="w-4 h-4 text-primary shrink-0" />
      )}
    </button>
  )

  return (
    <div className="space-y-4">
      {/* Provider Dropdown Selector */}
      <div className="relative" ref={dropdownRef}>
        <label className="block text-sm font-medium text-muted-foreground mb-1.5">
          {t('Provider')}
        </label>
        <button
          onClick={() => setShowProviderDropdown(!showProviderDropdown)}
          className="w-full flex items-center justify-between px-3 py-2.5 bg-input border border-border rounded-lg
                   text-foreground hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <span className="text-sm font-bold text-primary">
                {currentProvider?.name.charAt(0) || 'C'}
              </span>
            </div>
            <div className="text-left">
              <div className="text-sm font-medium">{currentProvider?.name || t('Select provider')}</div>
              {currentProvider?.description && (
                <div className="text-xs text-muted-foreground">{currentProvider.description}</div>
              )}
            </div>
          </div>
          <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${showProviderDropdown ? 'rotate-180' : ''}`} />
        </button>

        {/* Dropdown Menu */}
        {showProviderDropdown && (
          <div className="absolute z-50 w-full mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden">
            {/* Search Input */}
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  value={providerSearchQuery}
                  onChange={(e) => setProviderSearchQuery(e.target.value)}
                  placeholder={t('Search providers...')}
                  className="w-full pl-9 pr-3 py-2 text-sm bg-input border border-border rounded-lg
                           text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                  autoFocus
                />
              </div>
            </div>

            {/* Scrollable List */}
            <div className="max-h-80 overflow-y-auto">
              {/* Recommended Section */}
              {filteredRecommended.length > 0 && (
                <>
                  <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary/30 flex items-center gap-1.5">
                    <Star className="w-3 h-3 text-amber-500" />
                    {t('Recommended')}
                  </div>
                  {filteredRecommended.map(p => renderProviderItem(p, false))}
                </>
              )}

              {/* Other Providers Section */}
              {filteredOthers.length > 0 && (
                <>
                  <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary/30">
                    {t('All Providers')}
                  </div>
                  {filteredOthers.map(p => renderProviderItem(p, true))}
                </>
              )}

              {/* No Results */}
              {filteredRecommended.length === 0 && filteredOthers.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('No providers found')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Selected Provider Config */}
      {currentProvider && (
        <div className="space-y-4 p-4 bg-secondary/30 rounded-lg border border-border">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">
              {t('Configure')} {currentProvider.name}
            </h3>
            {currentProvider.website && (
              <a
                href={currentProvider.website}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {t('Get API Key')}
                <ExternalLink size={14} />
              </a>
            )}
          </div>

          {/* Source Name */}
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              {t('Display Name')}
            </label>
            <input
              type="text"
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              placeholder={currentProvider.name}
              className="w-full px-3 py-2 bg-input border border-border rounded-lg
                       text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              API Key
            </label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 pr-10 bg-input border border-border rounded-lg
                         text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              >
                {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {/* API URL (for anthropic and openai - protocol entries that support custom URL) */}
          {(selectedProvider === 'anthropic' || selectedProvider === 'openai') && (
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                API URL
              </label>
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder={currentProvider?.apiUrl || 'https://api.example.com/v1'}
                className="w-full px-3 py-2 bg-input border border-border rounded-lg
                         text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('Default official URL, modify for custom proxy')}
              </p>
            </div>
          )}

          {/* Model Selection */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-muted-foreground">
                {t('Model')}
              </label>
              <button
                onClick={handleFetchModels}
                disabled={isFetchingModels || !apiKey}
                className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 disabled:opacity-50"
              >
                {isFetchingModels ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Search size={14} />
                )}
                {t('Fetch Models')}
              </button>
            </div>

            {/* Custom model toggle */}
            <div className="flex items-center gap-2 mb-2">
              <input
                type="checkbox"
                id="customModel"
                checked={showCustomModel}
                onChange={(e) => setShowCustomModel(e.target.checked)}
                className="rounded border-border"
              />
              <label htmlFor="customModel" className="text-sm text-muted-foreground">
                {t('Use custom model ID')}
              </label>
            </div>

            {showCustomModel ? (
              <input
                type="text"
                value={customModelInput}
                onChange={(e) => setCustomModelInput(e.target.value)}
                placeholder={t('Enter model ID')}
                className="w-full px-3 py-2 bg-input border border-border rounded-lg
                         text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            ) : (
              <div className="relative">
                <button
                  onClick={() => setShowModelDropdown(!showModelDropdown)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-input
                           border border-border rounded-lg text-foreground
                           hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <span className="truncate">{selectedModel || t('Select model')}</span>
                  <ChevronDown size={18} className={`transition-transform shrink-0 ${showModelDropdown ? 'rotate-180' : ''}`} />
                </button>

                {showModelDropdown && (
                  <div className="absolute z-50 w-full mt-1 bg-card border border-border
                                rounded-lg shadow-lg max-h-60 overflow-hidden">
                    {/* Search */}
                    <div className="p-2 border-b border-border">
                      <div className="relative">
                        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <input
                          type="text"
                          value={modelSearchQuery}
                          onChange={(e) => setModelSearchQuery(e.target.value)}
                          placeholder={t('Search models...')}
                          className="w-full pl-8 pr-3 py-1.5 text-sm bg-input border border-border
                                   rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                      </div>
                    </div>

                    {/* Model list */}
                    <div className="max-h-48 overflow-y-auto">
                      {filteredModels.map(model => {
                        const isSelected = selectedModel === model.id
                        const showDelete = canDeleteModel() && !isSelected

                        return (
                          <div
                            key={model.id}
                            onClick={() => {
                              setSelectedModel(model.id)
                              setShowModelDropdown(false)
                              setModelSearchQuery('')
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/80 cursor-pointer ${
                              isSelected ? 'bg-primary/10' : ''
                            }`}
                          >
                            {isSelected ? (
                              <Check size={14} className="text-primary shrink-0" />
                            ) : (
                              <span className="w-[14px] shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-foreground truncate">{model.name}</div>
                              {model.name !== model.id && (
                                <div className="text-xs text-muted-foreground truncate">{model.id}</div>
                              )}
                            </div>
                            {showDelete && (
                              <button
                                onClick={(e) => handleDeleteModel(model.id, e)}
                                className="p-1 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-colors shrink-0"
                                title={t('Remove model')}
                              >
                                <X size={14} />
                              </button>
                            )}
                          </div>
                        )
                      })}
                      {filteredModels.length === 0 && (
                        <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                          {t('No models found')}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Notes */}
          {currentProvider.notes && (
            <div className="text-xs text-muted-foreground p-2 bg-secondary/50 rounded-lg">
              {currentProvider.notes}
            </div>
          )}

          {/* Validation Result */}
          {validationResult && (
            <div className={`flex items-center gap-2 p-2 rounded-lg ${
              validationResult.valid
                ? 'bg-green-500/10 text-green-600'
                : 'bg-red-500/10 text-red-600'
            }`}>
              {validationResult.valid ? <Check size={16} /> : <X size={16} />}
              <span className="text-sm">{validationResult.message}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onCancel}
              className="flex-1 px-4 py-2 bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground rounded-lg transition-colors"
            >
              {t('Cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={isValidating || !apiKey}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg
                       hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isValidating && <Loader2 size={16} className="animate-spin" />}
              {editingSource ? t('Update') : t('Save')}
            </button>
          </div>
          {/* Test connection link */}
          <div className="flex justify-end pt-1">
            <button
              onClick={handleTestConnection}
              disabled={isValidating || !apiKey}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {t('Test connection')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
