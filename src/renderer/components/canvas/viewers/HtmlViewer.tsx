/**
 * HTML Viewer - HTML preview with source toggle
 *
 * Features:
 * - Live preview isolated from the app: on the desktop a file inside a space
 *   is served from its own origin (halo-preview://, an out-of-process frame
 *   whose relative URLs resolve in the file's directory and which may use
 *   https: CDNs); any other file, or no file, is a srcdoc in an opaque-origin
 *   sandbox (main refuses the origin and the viewer falls back).
 *   Either way page script cannot reach the app window, its preload API or
 *   its storage.
 * - Toggle between preview and source view
 * - Syntax highlighted source code
 * - Copy to clipboard
 * - Window maximize for fullscreen viewing
 * - "Open in Browser" mode for full rendering capabilities
 */

import { useState, useRef, useMemo, useEffect } from 'react'
import { Copy, Check, Code, Eye, ExternalLink, Globe } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useCanvasActions } from '../../../hooks/useCanvasLifecycle'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { buildHtmlPreviewDocument, openIsolatedPreview } from './html-preview'
import { countLines } from './count-lines'
import { useViewerResources } from '../viewer-resources'

interface HtmlViewerProps {
  tab: CanvasTab
}

/** Bumped per content change so the isolated frame reloads the rewritten file. */
let previewRevision = 0

export function HtmlViewer({ tab }: HtmlViewerProps) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const resources = useViewerResources()
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState(false)

  const content = tab.content || ''

  // null while the origin is being set up; 'srcdoc' when it is unavailable.
  const [isolatedUrl, setIsolatedUrl] = useState<string | 'srcdoc' | null>(() =>
    api.isRemoteMode() || !tab.path ? 'srcdoc' : null
  )
  useEffect(() => {
    if (api.isRemoteMode() || !tab.path) return
    const scope = resources.scope()
    let active = true
    void openIsolatedPreview(api.openHtmlPreview, tab.path).then((preview) => {
      if (preview) scope.add(() => void api.closeHtmlPreview(preview.host))
      if (active) setIsolatedUrl(preview ? preview.url : 'srcdoc')
    })
    return () => {
      active = false
      scope.dispose()
    }
  }, [resources, tab.path])
  const revision = useMemo(() => ++previewRevision, [content])

  // Copy content
  const handleCopy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }


  // Open in new window - write to temp file or use data URI
  const handleOpenExternal = async () => {
    if (!content) return

    // For desktop mode, we can use openArtifact if we have the file path
    if (tab.path && !api.isRemoteMode()) {
      try {
        await api.openArtifact(tab.path)
        return
      } catch (error) {
        console.error('Failed to open with system app:', error)
      }
    }

    // Fallback: Open as data URI in new tab
    const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(content)}`
    window.open(dataUri, '_blank')
  }

  const lineCount = useMemo(
    () => (viewMode === 'source' ? countLines(content) : 0),
    [viewMode, content]
  )

  // halo-file:// only exists on the desktop; a remote client has no local file to resolve against.
  const previewPath = api.isRemoteMode() ? undefined : tab.path
  const previewDocument = useMemo(
    () => (isolatedUrl === 'srcdoc' ? buildHtmlPreviewDocument(content, previewPath) : ''),
    [isolatedUrl, content, previewPath]
  )

  // Open in embedded browser (BrowserViewer)
  const { openUrl, closeTab } = useCanvasActions()

  const handleOpenInBrowser = async () => {
    if (!tab.path) return

    // For local files, use file:// protocol
    const fileUrl = `file://${tab.path}`
    openUrl(fileUrl, tab.title)

    // Close the current HtmlViewer tab
    closeTab(tab.id)
  }

  // Check if browser mode is available (desktop only)
  const canOpenInBrowser = !api.isRemoteMode() && tab.path

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex items-center rounded-md bg-secondary/50 p-0.5">
            <button
              onClick={() => setViewMode('preview')}
              className={`
                flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors
                ${viewMode === 'preview'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
                }
              `}
            >
              <Eye className="w-3.5 h-3.5" />
              {t('Preview')}
            </button>
            <button
              onClick={() => setViewMode('source')}
              className={`
                flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors
                ${viewMode === 'source'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
                }
              `}
            >
              <Code className="w-3.5 h-3.5" />
              {t('Source')}
            </button>
          </div>

          {viewMode === 'source' && (
            <span className="text-xs text-muted-foreground">
              {t('{{count}} lines', { count: lineCount })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Open in Browser - full rendering in an embedded browser page */}
          {canOpenInBrowser && (
            <button
              onClick={handleOpenInBrowser}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
              title={t('Open in browser mode (full render)')}
            >
              <Globe className="w-3.5 h-3.5" />
              {t('Browser mode')}
            </button>
          )}

          {/* Open external */}
          <button
            onClick={handleOpenExternal}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Open in external browser')}
          >
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </button>

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Copy code')}
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {viewMode === 'preview' ? (
          isolatedUrl === 'srcdoc' ? (
            <iframe
              ref={iframeRef}
              srcDoc={previewDocument}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-forms allow-popups"
              title={tab.title}
            />
          ) : isolatedUrl ? (
            // Its own site, so allow-same-origin gives it that origin (storage,
            // same-origin fetches), never the app's.
            <iframe
              key={revision}
              ref={iframeRef}
              src={isolatedUrl}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
              title={tab.title}
            />
          ) : (
            <div className="w-full h-full bg-white" />
          )
        ) : (
          <CodeMirrorEditor content={content} language="html" readOnly />
        )}
      </div>
    </div>
  )
}
