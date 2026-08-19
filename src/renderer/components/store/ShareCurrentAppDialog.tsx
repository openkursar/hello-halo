/**
 * ShareCurrentAppDialog
 *
 * "Share this installed app" chooser opened from a Digital Human / Skill detail
 * page (AutomationHeader, SkillInfoCard). Two actions:
 *   - Export: save the app as a .dhpkg file to share by hand (desktop only).
 *   - Share:  jump to the store and open the unified publish dialog
 *             (ShareToStoreDialog) pre-selected on this app.
 *
 * Publishing itself lives entirely in ShareToStoreDialog so there is a single
 * publish flow (author/version/category/review) rather than a second inline one.
 */

import { useCallback, useState } from 'react'
import { X, Share2, Loader2, AlertCircle, CheckCircle2, Bot, BookOpen, Puzzle, Wrench, Download } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import type { AppType } from '../../../shared/apps/spec-types'

export interface ShareCurrentAppDialogProps {
  appId: string
  onClose: () => void
}

type Feedback = { kind: 'success' | 'error'; text: string }

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
  const openStorePublish = useAppsPageStore(s => s.openStorePublish)

  const [exporting, setExporting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const handleShareToMarket = useCallback(() => {
    if (!app) return
    // Only digital humans and skills are publishable; the store publish dialog
    // is scoped to those two types.
    const shareType: AppType = app.spec.type === 'skill' ? 'skill' : 'automation'
    onClose()
    openStorePublish(shareType, appId)
  }, [app, appId, onClose, openStorePublish])

  const handleExport = useCallback(async () => {
    if (!app) return
    setExporting(true)
    setFeedback(null)
    try {
      // Skills distribute as a `.zip` of their file tree; digital humans as a
      // `.dhpkg` (spec.yaml package). Each type gets its own export format.
      const res = app.spec.type === 'skill'
        ? await api.storeExportSkill(appId)
        : await api.storeExportDhpkg(appId)
      if (res.success && res.data?.path) {
        setFeedback({ kind: 'success', text: t('Saved to {{path}}', { path: res.data.path }) })
      } else if (res.error && res.error !== 'User cancelled') {
        setFeedback({ kind: 'error', text: res.error })
      }
    } catch (err) {
      setFeedback({ kind: 'error', text: (err as Error).message })
    } finally {
      setExporting(false)
    }
  }, [app, appId, t])

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

          <p className="text-xs text-muted-foreground">
            {t('Share opens the store publish dialog pre-filled with this app, where you review and publish it.')}
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
              onClick={handleExport}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors disabled:opacity-40"
              title={t('Save a package file you can share by hand')}
            >
              {exporting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />}
              {t('Export')}
            </button>
          )}
          <button
            onClick={handleShareToMarket}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Share2 className="w-3.5 h-3.5" />
            {t('Share to Store')}
          </button>
        </div>
      </div>
    </div>
  )
}
