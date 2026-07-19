/**
 * Store Install Dialog
 *
 * Modal dialog for installing an app from the store.
 * Shows space selector and config_schema form fields.
 */

import { useState, useMemo, useCallback } from 'react'
import { X, Loader2 } from 'lucide-react'
import { useSpaceStore } from '../../stores/space.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import type { StoreAppDetail, StoreInstallProgress } from '../../../shared/store/store-types'
import type { InputDef } from '../../../shared/apps/spec-types'

// Sentinel value used in <select> to represent spaceId = null (global)
const GLOBAL_SCOPE = '__global__'

interface StoreInstallDialogProps {
  detail: StoreAppDetail
  onClose: () => void
  onInstalled: (appId: string) => void
  /** If true, adds "Global (all spaces)" as the first scope option */
  showGlobalOption?: boolean
}

export function StoreInstallDialog({ detail, onClose, onInstalled, showGlobalOption }: StoreInstallDialogProps) {
  const { t } = useTranslation()
  const installFromStore = useAppsPageStore(state => state.installFromStore)

  // Spaces
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)

  const allSpaces = useMemo(() => {
    const result: Array<{ id: string; name: string; icon: string }> = []
    if (haloSpace) result.push(haloSpace)
    result.push(...spaces)
    return result
  }, [haloSpace, spaces])

  // For MCP/Skill (showGlobalOption=true), default to global; otherwise default to current/first space
  const [selectedSpaceId, setSelectedSpaceId] = useState(
    showGlobalOption ? GLOBAL_SCOPE : (currentSpace?.id ?? allSpaces[0]?.id ?? '')
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<StoreInstallProgress | null>(null)

  // Dynamic config form state — use resolved schema for translated display text;
  // field.key and field.required are preserved unchanged by resolveSpecI18n.
  const configSchema = resolveSpecI18n(detail.spec, getCurrentLanguage()).config_schema ?? []
  const [configValues, setConfigValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {}
    for (const field of configSchema) {
      if (field.default !== undefined) {
        initial[field.key] = field.default
      } else {
        initial[field.key] = ''
      }
    }
    return initial
  })

  const updateConfigValue = useCallback((key: string, value: unknown) => {
    setConfigValues(prev => ({ ...prev, [key]: value }))
    setError(null)
  }, [])

  const handleInstall = useCallback(async () => {
    setError(null)
    setProgress(null)
    setLoading(true)

    try {
      if (!selectedSpaceId) {
        setError(t('Please select a scope'))
        setLoading(false)
        return
      }

      // Validate required fields
      for (const field of configSchema) {
        if (field.required) {
          const val = configValues[field.key]
          if (val === undefined || val === null || val === '') {
            setError(t('{{field}} is required').replace('{{field}}', field.label))
            setLoading(false)
            return
          }
        }
      }

      // Build user config (only include fields that have values)
      const userConfig: Record<string, unknown> = {}
      for (const field of configSchema) {
        const val = configValues[field.key]
        if (val !== undefined && val !== null && val !== '') {
          userConfig[field.key] = val
        }
      }

      // Map sentinel '__global__' back to null for global installs
      const resolvedSpaceId = selectedSpaceId === GLOBAL_SCOPE ? null : selectedSpaceId

      const appId = await installFromStore(
        detail.entry.slug,
        resolvedSpaceId,
        Object.keys(userConfig).length > 0 ? userConfig : undefined,
        setProgress,
      )

      if (appId) {
        onInstalled(appId)
      } else {
        setError(t('Installation failed. Please try again.'))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('already installed')) {
        setError(t('This app is already installed in the selected scope.'))
      } else {
        setError(msg || t('Installation failed'))
      }
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }, [configSchema, configValues, detail.entry.slug, selectedSpaceId, installFromStore, onInstalled, t])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="relative w-full max-w-lg mx-4 bg-background border border-border rounded-xl shadow-xl flex flex-col max-h-[85vh]"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {detail.entry.icon && (
              <span className="text-base">{detail.entry.icon}</span>
            )}
            <h2 className="text-sm font-semibold truncate">
              {t('Install')} {resolveSpecI18n(detail.spec, getCurrentLanguage()).name}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground rounded-md transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* Scope selector */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Install to')}
            </h3>
            {!showGlobalOption && allSpaces.length <= 1 ? (
              <p className="text-sm text-foreground">
                {allSpaces[0]?.name ?? t('No spaces available')}
              </p>
            ) : (
              <select
                value={selectedSpaceId}
                onChange={e => setSelectedSpaceId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
              >
                {showGlobalOption && (
                  <option value={GLOBAL_SCOPE}>{t('Global (all spaces)')}</option>
                )}
                {allSpaces.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Config schema form fields */}
          {configSchema.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('Configuration')}
              </h3>
              {configSchema.map(field => (
                <ConfigField
                  key={field.key}
                  field={field}
                  value={configValues[field.key]}
                  onChange={val => updateConfigValue(field.key, val)}
                />
              ))}
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>

        {/* Install progress bar (shown while downloading) */}
        {loading && progress && (
          <div className="px-4 pt-2 pb-1 space-y-1 border-t border-border flex-shrink-0">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{progress.message}</span>
              {progress.filesTotal > 0 && (
                <span>{progress.filesComplete}/{progress.filesTotal}</span>
              )}
            </div>
            <div className="w-full h-1 bg-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-200"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleInstall}
            disabled={loading || !selectedSpaceId}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('Install')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// Config Field sub-component
// ──────────────────────────────────────────────

interface ConfigFieldProps {
  field: InputDef
  value: unknown
  onChange: (value: unknown) => void
}

function ConfigField({ field, value, onChange }: ConfigFieldProps) {
  const { t } = useTranslation()

  const inputClasses = 'w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50'

  switch (field.type) {
    case 'boolean':
      return (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={!!value}
              onChange={e => onChange(e.target.checked)}
              className="rounded border-border"
            />
            {field.label}
            {field.required && <span className="text-red-400">*</span>}
          </label>
          {field.description && (
            <p className="text-xs text-muted-foreground ml-6">{field.description}</p>
          )}
        </div>
      )

    case 'select':
      return (
        <div className="space-y-1.5">
          <label className="text-sm text-foreground">
            {field.label}
            {field.required && <span className="text-red-400 ml-0.5">*</span>}
          </label>
          {field.description && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
          <select
            value={String(value ?? '')}
            onChange={e => onChange(e.target.value)}
            className={inputClasses}
          >
            <option value="">{t('Select...')}</option>
            {field.options?.map(opt => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )

    case 'number':
      return (
        <div className="space-y-1.5">
          <label className="text-sm text-foreground">
            {field.label}
            {field.required && <span className="text-red-400 ml-0.5">*</span>}
          </label>
          {field.description && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
          <input
            type="number"
            value={String(value ?? '')}
            onChange={e => onChange(e.target.value ? Number(e.target.value) : '')}
            placeholder={field.placeholder}
            className={inputClasses}
          />
        </div>
      )

    case 'text':
      return (
        <div className="space-y-1.5">
          <label className="text-sm text-foreground">
            {field.label}
            {field.required && <span className="text-red-400 ml-0.5">*</span>}
          </label>
          {field.description && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
          <textarea
            value={String(value ?? '')}
            onChange={e => onChange(e.target.value)}
            placeholder={field.placeholder}
            rows={3}
            className={`${inputClasses} resize-none`}
          />
        </div>
      )

    default:
      // string, url, email — render as text input
      return (
        <div className="space-y-1.5">
          <label className="text-sm text-foreground">
            {field.label}
            {field.required && <span className="text-red-400 ml-0.5">*</span>}
          </label>
          {field.description && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
          <input
            type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            value={String(value ?? '')}
            onChange={e => onChange(e.target.value)}
            placeholder={field.placeholder}
            className={inputClasses}
          />
        </div>
      )
  }
}
