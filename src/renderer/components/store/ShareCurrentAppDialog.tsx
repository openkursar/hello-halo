/**
 * ShareCurrentAppDialog
 *
 * Single-layer "share this installed app" dialog: the dialog itself is the
 * confirmation step. Primary action publishes to the store immediately;
 * a secondary action exports the app as a .dhpkg file.
 *
 * Publish pre-check: on open (and when the author — and therefore the target
 * slug — changes) the store's current version is looked up so the user sees
 * "store vX → publishing vY" with an editable version. Publishing is blocked
 * client-side when vY ≤ vX; the registry enforces the same rule (422) as the
 * backstop. After a successful publish the final version is written back to
 * the local spec so local and store never diverge.
 *
 * Used by the Share buttons on individual Digital Human / Skill detail pages
 * (AutomationHeader, SkillInfoCard). For the store-header "I have nothing
 * picked yet" entry, use ShareToStoreDialog instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Share2, Loader2, AlertCircle, CheckCircle2, Bot, BookOpen, Puzzle, Wrench, Upload, Download } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import type { AppType } from '../../../shared/apps/spec-types'
import { compareDotVersions, suggestNextVersion } from '../../../shared/store/version-compare'
import { AuthorField } from './AuthorField'
import { loadStoredAuthor, saveAuthor } from './publish-author'

export interface ShareCurrentAppDialogProps {
  appId: string
  onClose: () => void
}

type Feedback = { kind: 'success' | 'error'; text: string }
type PublishPreview = { slug: string; localVersion: string; storeVersion: string | null }

/** Pick a representative icon for the preview header by app type. */
function iconForType(type: AppType): typeof Bot {
  switch (type) {
    case 'automation': return Bot
    case 'skill':      return BookOpen
    case 'mcp':        return Wrench
    case 'extension':  return Puzzle
    default:           return Puzzle
  }
}

function typeLabel(type: AppType, t: (s: string) => string): string {
  switch (type) {
    case 'automation': return t('Digital Human')
    case 'skill':      return t('Skill')
    case 'mcp':        return t('MCP')
    case 'extension':  return t('Extension')
    default:           return type
  }
}

export function ShareCurrentAppDialog({ appId, onClose }: ShareCurrentAppDialogProps) {
  const { t } = useTranslation()
  const app = useAppsStore(s => s.apps.find(a => a.id === appId))

  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [author, setAuthor] = useState(() => loadStoredAuthor() || app?.spec.author || '')

  const [preview, setPreview] = useState<PublishPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [version, setVersion] = useState(() => app?.spec.version ?? '')
  // Once the user touches the version field, preview refreshes stop overwriting it.
  const versionEditedRef = useRef(false)
  const previewSeqRef = useRef(0)

  useEffect(() => {
    const trimmed = author.trim()
    if (!trimmed) {
      setPreview(null)
      return
    }
    const seq = ++previewSeqRef.current
    setPreviewLoading(true)
    // Debounce: the author field changes the target slug on every keystroke.
    const timer = setTimeout(async () => {
      try {
        const res = await api.storePublishPreview(appId, trimmed)
        if (seq !== previewSeqRef.current) return
        if (res.success && res.data) {
          setPreview(res.data)
          if (!versionEditedRef.current) {
            const { localVersion, storeVersion } = res.data
            setVersion(
              storeVersion && compareDotVersions(localVersion, storeVersion) <= 0
                ? suggestNextVersion(storeVersion)
                : localVersion
            )
          }
        } else {
          setPreview(null)
        }
      } catch {
        if (seq === previewSeqRef.current) setPreview(null)
      } finally {
        if (seq === previewSeqRef.current) setPreviewLoading(false)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [appId, author])

  const versionTooLow = Boolean(
    preview?.storeVersion &&
    version.trim() &&
    compareDotVersions(version.trim(), preview.storeVersion) <= 0
  )

  const handlePublish = useCallback(async () => {
    const trimmedAuthor = author.trim()
    if (!trimmedAuthor) {
      setFeedback({ kind: 'error', text: t('Author is required') })
      return
    }
    const trimmedVersion = version.trim()
    setFeedback(null)
    setPublishing(true)
    try {
      saveAuthor(trimmedAuthor)
      const res = await api.storePublish(appId, trimmedAuthor, trimmedVersion || undefined)
      if (!res.success) {
        const raw = res.error ?? t('Publish failed.')
        // Registry backstop for the version-monotonicity rule — translate
        // the wire error into something actionable before the raw details.
        const text = /HTTP 422/.test(raw) && /version/i.test(raw)
          ? `${t('The store already has this version or a newer one. Increase the version number and try again.')}\n${raw}`
          : raw
        setFeedback({ kind: 'error', text })
        return
      }
      // Write the published version back to the local spec so local and
      // store never diverge after an in-dialog version edit.
      if (trimmedVersion && trimmedVersion !== app?.spec.version) {
        await useAppsStore.getState().updateAppSpec(appId, { version: trimmedVersion })
      }
      // Converge the registry cache so the next pre-check sees this release.
      api.storeRefresh().catch(() => {})
      const details = (res.data as { details?: string } | undefined)?.details
      setFeedback({ kind: 'success', text: details ?? t('Published successfully.') })
      setPublished(true)
    } catch (err) {
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : t('Publish failed.') })
    } finally {
      setPublishing(false)
    }
  }, [appId, app?.spec.version, author, version, t])

  const handleExportDhpkg = useCallback(async () => {
    setExporting(true)
    setFeedback(null)
    try {
      const res = await api.storeExportDhpkg(appId)
      if (res.success && res.data?.path) {
        setFeedback({ kind: 'success', text: t('Saved .dhpkg to {{path}}', { path: res.data.path }) })
      } else if (res.error && res.error !== 'User cancelled') {
        setFeedback({ kind: 'error', text: res.error })
      }
    } catch (err) {
      setFeedback({ kind: 'error', text: (err as Error).message })
    } finally {
      setExporting(false)
    }
  }, [appId, t])

  // App may have been uninstalled between mount and render — guard gracefully.
  if (!app) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        onMouseDown={onClose}
      >
        <div
          className="relative w-full max-w-md bg-background border border-border rounded-xl shadow-xl p-6"
          onMouseDown={e => e.stopPropagation()}
        >
          <p className="text-sm text-muted-foreground">
            {t('This app is no longer available.')}
          </p>
        </div>
      </div>
    )
  }

  const spec = app.spec
  const Icon = iconForType(spec.type)
  const label = typeLabel(spec.type, t)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="relative w-full max-w-md bg-background border border-border rounded-xl shadow-xl flex flex-col"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <Share2 className="w-4 h-4 text-primary flex-shrink-0" />
            <h2 className="text-sm font-semibold truncate">{t('Share')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            aria-label={t('Close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          <div className="flex items-start gap-3 p-3 bg-secondary/60 rounded-lg border border-border">
            <Icon className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground truncate">{spec.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {label}
                {spec.version && <> · v{spec.version}</>}
                {spec.author && <> · {t('by')} {spec.author}</>}
              </p>
              {spec.description && (
                <p className="text-xs text-muted-foreground/80 mt-1 line-clamp-3">
                  {spec.description}
                </p>
              )}
            </div>
          </div>

          <AuthorField value={author} onChange={v => { setAuthor(v); setFeedback(null) }} />

          {/* Version pre-check */}
          <div className="space-y-1">
            <label htmlFor="publish-version" className="text-xs font-medium text-muted-foreground">
              {t('Version')}
            </label>
            <div className="flex items-center gap-2">
              <span className="flex items-center text-xs text-muted-foreground whitespace-nowrap">
                {previewLoading
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : preview?.storeVersion
                    ? <>{t('Store version v{{version}}', { version: preview.storeVersion })} →</>
                    : preview
                      ? t('First publish')
                      : null}
              </span>
              <input
                id="publish-version"
                type="text"
                value={version}
                onChange={e => {
                  versionEditedRef.current = true
                  setVersion(e.target.value)
                  setFeedback(null)
                }}
                placeholder={spec.version ?? '1.0.0'}
                className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-secondary text-foreground border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {versionTooLow && (
              <p className="text-xs text-red-400">
                {t('Version must be greater than the store version v{{version}}', { version: preview!.storeVersion })}
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {t('Once published, other users will be able to find and install it from the store.')}
          </p>

          {feedback && (
            <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
              feedback.kind === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-red-500/10 border-red-500/20 text-red-400'
            }`}>
              {feedback.kind === 'success'
                ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
              <span className="whitespace-pre-wrap break-words">{feedback.text}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          {isElectron() && (
            <button
              onClick={handleExportDhpkg}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors disabled:opacity-40"
              title={t('Save a .dhpkg file you can share by hand')}
            >
              {exporting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />}
              {t('Export')}
            </button>
          )}
          {!published && (
            <button
              onClick={handlePublish}
              disabled={publishing || versionTooLow || !version.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {publishing
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Upload className="w-3.5 h-3.5" />}
              {publishing ? t('Publishing...') : t('Publish to Store')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
