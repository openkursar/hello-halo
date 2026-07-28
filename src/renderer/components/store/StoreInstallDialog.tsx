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
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { AppTypeIcon } from './AppTypeIcon'
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
  // Install downloads spec+files from the registry; block it while offline so it
  // cannot hang, and cover connectivity dropping after the dialog opened.
  const online = useOnlineStatus()

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
  // Required config keys flagged by a failed install; cleared as each is filled.
  const [invalid, setInvalid] = useState<Set<string>>(new Set())
  const clearInvalid = useCallback((key: string) => {
    setInvalid(prev => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  // Dynamic config form state — use resolved schema for translated display text;
  // field.key and field.required are preserved unchanged by resolveSpecI18n.
  const configSchema = resolveSpecI18n(detail.spec, getCurrentLanguage()).config_schema ?? []
  const hasConfig = configSchema.length > 0

  // Two-step flow: pick the install location first (with a note on what that
  // means), then configure. Apps without a config schema skip the second step.
  const [step, setStep] = useState<'scope' | 'config'>('scope')
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
    clearInvalid(key)
    setError(null)
  }, [clearInvalid])

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

      // Validate required fields — flag every missing one at once (red) rather
      // than stopping at the first, matching the publish form.
      const missing = new Set<string>()
      for (const field of configSchema) {
        if (!field.required) continue
        const val = configValues[field.key]
        if (val === undefined || val === null || val === '') missing.add(field.key)
      }
      if (missing.size > 0) {
        setInvalid(missing)
        setError(t('Please complete the required fields'))
        setLoading(false)
        return
      }
      setInvalid(new Set())

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
        className="relative w-full max-w-lg mx-4 bg-background border border-border/60 rounded-xl shadow-xl flex flex-col max-h-[85vh]"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header — app icon + name + step/context meta (matches the mockup) */}
        <div className="relative flex-shrink-0 px-7 pt-6 pb-[18px] border-b border-border/60">
          <div className="flex items-start gap-4 pr-8">
            <AppTypeIcon type={detail.entry.type} icon={detail.entry.icon} name={detail.entry.name} size="lg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold text-foreground truncate">
                {resolveSpecI18n(detail.spec, getCurrentLanguage()).name}
              </h2>
              <p className="text-xs text-muted-foreground mt-1.5">
                {hasConfig
                  ? (step === 'scope' ? t('Step 1 of 2 · Choose where to install') : t('Step 2 of 2 · Configure'))
                  : t('Install settings')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="absolute top-4 right-4 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground hover:text-foreground hover:border-border transition-colors"
            aria-label={t('Close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-7 py-5 space-y-4 overflow-y-auto flex-1">
          {step === 'scope' ? (
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-muted-foreground">
                {t('Install to')}
              </label>
              {!showGlobalOption && allSpaces.length <= 1 ? (
                <p className="text-sm text-foreground">
                  {allSpaces[0]?.name ?? t('No spaces available')}
                </p>
              ) : (
                <select
                  value={selectedSpaceId}
                  onChange={e => setSelectedSpaceId(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-muted/40 border border-border/60 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                >
                  {showGlobalOption && (
                    <option value={GLOBAL_SCOPE}>{t('Global (all spaces)')}</option>
                  )}
                  {allSpaces.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
              {/* What the scope choice means */}
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
                {showGlobalOption
                  ? t('Global installs it once and makes it available across every space. Installing into a single space keeps it available only there — pick a space to scope it to that workspace.')
                  : t('The app is installed into the selected space and runs and is managed within that space; other spaces are not affected.')}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block text-xs font-semibold text-muted-foreground">
                {t('Configuration')}
              </label>
              {configSchema.map(field => (
                <ConfigField
                  key={field.key}
                  field={field}
                  value={configValues[field.key]}
                  invalid={invalid.has(field.key)}
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
          <div className="px-4 pt-2 pb-1 space-y-1 border-t border-border/60 flex-shrink-0">
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
        <div className="flex items-center gap-3 px-7 py-4 border-t border-border/60 flex-shrink-0">
          {step === 'config' ? (
            <button
              onClick={() => { setStep('scope'); setError(null) }}
              disabled={loading}
              className="flex-1 px-5 py-2.5 text-[13px] text-muted-foreground border border-border/60 rounded-lg hover:text-foreground hover:border-border transition-colors disabled:opacity-50"
            >
              {t('Back')}
            </button>
          ) : (
            <button
              onClick={onClose}
              className="flex-1 px-5 py-2.5 text-[13px] text-muted-foreground border border-border/60 rounded-lg hover:text-foreground hover:border-border transition-colors"
            >
              {t('Cancel')}
            </button>
          )}
          {step === 'scope' && hasConfig ? (
            <button
              onClick={() => { setError(null); setStep('config') }}
              disabled={!selectedSpaceId}
              className="flex-1 flex items-center justify-center gap-1.5 px-5 py-2.5 text-[13px] font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {t('Next')}
            </button>
          ) : (
            <button
              onClick={handleInstall}
              disabled={loading || !selectedSpaceId || !online}
              title={online ? undefined : t('You are offline. Connect to the network to install.')}
              className="flex-1 flex items-center justify-center gap-1.5 px-5 py-2.5 text-[13px] font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {online ? t('Install') : t('Offline')}
            </button>
          )}
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
  /** Highlight red when a failed install flagged this required field as empty. */
  invalid?: boolean
  onChange: (value: unknown) => void
}

function ConfigField({ field, value, invalid, onChange }: ConfigFieldProps) {
  const { t } = useTranslation()

  const inputClasses = `w-full px-3 py-2 text-sm bg-muted/40 border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50 ${invalid ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border/60'}`

  switch (field.type) {
    case 'boolean':
      return (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={!!value}
              onChange={e => onChange(e.target.checked)}
              className={`rounded ${invalid ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border/60'}`}
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
