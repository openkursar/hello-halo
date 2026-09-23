/**
 * Shared fallback body for office viewers: unsupported-format placeholder and
 * parse-failure state, with an escape hatch (open externally on desktop,
 * download in remote/web mode).
 */

import { FileWarning, ExternalLink, Download } from 'lucide-react'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'

interface OfficeFallbackProps {
  tab: CanvasTab
  title: string
  detail?: string
}

export function OfficeFallback({ tab, title, detail }: OfficeFallbackProps) {
  const { t } = useTranslation()
  const isRemote = api.isRemoteMode()

  const handleOpenExternal = async () => {
    if (!tab.path) return
    try {
      await api.openArtifact(tab.path)
    } catch (err) {
      console.error('[OfficeFallback] Failed to open with external app:', err)
    }
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-3 text-center max-w-md px-4">
        <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
          <FileWarning className="w-6 h-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">{title}</p>
        {detail && <p className="text-sm text-muted-foreground break-words">{detail}</p>}
        {tab.path && (
          <div className="flex flex-col sm:flex-row items-center gap-2 mt-1">
            {!isRemote && (
              <button
                onClick={handleOpenExternal}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 transition-opacity"
              >
                <ExternalLink className="w-4 h-4" />
                {t('Open in external application')}
              </button>
            )}
            <button
              onClick={() => api.downloadArtifact(tab.path!)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-sm text-foreground hover:bg-secondary transition-colors"
            >
              <Download className="w-4 h-4" />
              {t('Download')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
