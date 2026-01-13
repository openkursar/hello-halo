/**
 * HTML Viewer - HTML preview with source toggle
 *
 * Features:
 * - Live HTML preview using srcdoc (CSP-compliant)
 * - Toggle between preview and source view
 * - Syntax highlighted source code
 * - Copy to clipboard
 * - Window maximize for fullscreen viewing
 * - "Open in Browser" mode for full rendering capabilities
 */

import { useState, useRef, useMemo } from 'react'
import { Copy, Check, Code, Eye, ExternalLink, Globe } from 'lucide-react'
import { highlightCodeSync } from '../../../lib/highlight-loader'
import { useTranslation } from '../../../i18n'
import { api } from '../../../api'
import { useCanvasStore, type CanvasTab } from '../../../stores/canvas.store'

interface HtmlViewerProps {
  tab: CanvasTab
}

export function HtmlViewer({ tab }: HtmlViewerProps) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState(false)

  const content = tab.content || ''

  // Highlighted source code (HTML/XML is pre-loaded)
  const highlightedSource = useMemo(() => {
    if (!content) return ''
    return highlightCodeSync(content, 'html')
  }, [content])

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

  // Count lines for source view
  const lines = content.split('\n')

  // Open in embedded browser (BrowserViewer)
  const openUrl = useCanvasStore(state => state.openUrl)
  const closeTab = useCanvasStore(state => state.closeTab)

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
              {t('{{count}} lines', { count: lines.length })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Open in Browser - full rendering with BrowserView */}
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
          <iframe
            ref={iframeRef}
            srcDoc={content}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title={tab.title}
          />
        ) : (
          <div className="flex h-full font-mono text-sm overflow-auto">
            {/* Line numbers */}
            <div className="sticky left-0 flex-shrink-0 select-none bg-background/80 backdrop-blur-sm border-r border-border/50 text-right text-muted-foreground/40 text-xs pr-3 pl-4 py-4">
              {lines.map((_, i) => (
                <div key={i + 1} className="leading-6">
                  {i + 1}
                </div>
              ))}
            </div>

            {/* Code */}
            <pre className="flex-1 p-4 overflow-x-auto">
              <code
                className="hljs language-html"
                dangerouslySetInnerHTML={{ __html: highlightedSource }}
              />
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
