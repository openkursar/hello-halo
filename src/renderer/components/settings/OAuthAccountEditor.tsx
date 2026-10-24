/**
 * OAuthAccountEditor - edit a signed-in (OAuth) account's own settings.
 *
 * Only what Halo owns is editable here: the display name and per-model
 * capability overrides. Credentials, endpoint and the model catalog belong to
 * the provider and are refreshed by it, so they are never sent from this form.
 * Choosing a model only selects which model's settings to edit; the model in
 * use is changed from the model picker.
 */

import { useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import type { AISource } from '../../types'
import type { ModelCapabilityOverride } from '../../../shared/types/model-capabilities'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { ModelConfigPanel } from './ModelConfigPanel'
import { groupModels, useModelGroupLabel } from '../ai-config/model-list-parts'

interface OAuthAccountEditorProps {
  source: AISource
  /** Runs after the account is saved; reloads settings and closes the editor. */
  onSaved: () => Promise<void>
  onCancel: () => void
}

export function OAuthAccountEditor({ source, onSaved, onCancel }: OAuthAccountEditorProps) {
  const { t } = useTranslation()
  const groupLabel = useModelGroupLabel()
  const models = source.availableModels ?? []
  const [name, setName] = useState(source.name)
  const [modelId, setModelId] = useState(source.model || models[0]?.id || '')
  const [modelOverrides, setModelOverrides] = useState<Record<string, ModelCapabilityOverride>>(
    source.modelOverrides ?? {}
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const catalogModel = models.find(model => model.id === modelId)
  const trimmedName = name.trim()

  const handleSave = async () => {
    if (!trimmedName || saving) return
    setSaving(true)
    setError(null)
    try {
      // An empty map is sent rather than omitted: an absent field would leave
      // the stored overrides in place, so a full reset could never be saved.
      const result = await api.aiSourcesUpdateSource(source.id, { name: trimmedName, modelOverrides })
      if (!result.success) throw new Error(result.error || t('Failed to save account'))
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to save account'))
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 p-3 sm:p-4 bg-secondary/30 rounded-lg border border-border">
      <div>
        <label htmlFor="oauthAccountName" className="block text-sm font-medium text-muted-foreground mb-1">
          {t('Display Name')}
        </label>
        <input
          id="oauthAccountName"
          type="text"
          value={name}
          onChange={event => setName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) void handleSave()
          }}
          className="w-full px-3 py-2 bg-input border border-border rounded-lg
                   text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      <div>
        <label htmlFor="oauthAccountModel" className="block text-sm font-medium text-muted-foreground mb-1">
          {t('Model')}
        </label>
        {models.length > 0 || modelId ? (
          <div className="relative">
            <select
              id="oauthAccountModel"
              value={modelId}
              onChange={event => setModelId(event.target.value)}
              className="w-full px-3 py-2 pr-9 bg-input border border-border rounded-lg
                       text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 appearance-none"
            >
              {modelId && !catalogModel && <option value={modelId}>{modelId}</option>}
              {groupModels(models).map(section => {
                const options = section.models.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.id}
                  </option>
                ))
                return section.group
                  ? <optgroup key={section.group} label={groupLabel(section.group)}>{options}</optgroup>
                  : options
              })}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          </div>
        ) : (
          <div className="w-full px-3 py-2 bg-input border border-border rounded-lg text-sm text-muted-foreground">
            {t('No models available')}
          </div>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {t('Choose a model to adjust its settings. The model in use does not change.')}
        </p>
      </div>

      {modelId && (
        <ModelConfigPanel
          modelId={modelId}
          overrides={modelOverrides}
          onChange={setModelOverrides}
          catalogCapability={catalogModel?.capabilities}
          catalogSupportsVision={catalogModel?.supportsVision}
        />
      )}

      {error && (
        <div role="alert" className="p-2 bg-destructive/10 border border-destructive/20 rounded-lg">
          <p className="text-sm text-destructive break-words">{error}</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 pt-2">
        <button
          onClick={onCancel}
          disabled={saving}
          className="flex-1 px-4 py-2 bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground
                   rounded-lg transition-colors disabled:opacity-50"
        >
          {t('Cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !trimmedName}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg
                   hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {t('Save')}
        </button>
      </div>
    </div>
  )
}
