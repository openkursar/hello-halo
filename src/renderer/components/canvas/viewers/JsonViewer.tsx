/**
 * JSON Viewer - Formatted JSON display with tree view
 *
 * Features:
 * - Syntax highlighted JSON
 * - Collapsible tree view (future)
 * - Line numbers
 * - Copy to clipboard
 * - Window maximize for fullscreen viewing
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Copy, Check, ExternalLink, WrapText } from 'lucide-react'
import { highlightCodeSync } from '../../../lib/highlight-loader'
import { api } from '../../../api'
import { useTranslation } from '../../../i18n'
import type { CanvasTab } from '../../../stores/canvas.store'

interface JsonViewerProps {
  tab: CanvasTab
  onScrollChange?: (position: number) => void
}

export function JsonViewer({ tab, onScrollChange }: JsonViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [isFormatted, setIsFormatted] = useState(true)

  const content = tab.content || ''

  // Format or minify JSON
  const displayContent = useMemo(() => {
    if (!content) return ''
    try {
      const parsed = JSON.parse(content)
      return isFormatted
        ? JSON.stringify(parsed, null, 2)
        : JSON.stringify(parsed)
    } catch {
      // If invalid JSON, just show as-is
      return content
    }
  }, [content, isFormatted])

  // Syntax highlight (JSON is pre-loaded, so sync is fine)
  const highlightedContent = useMemo(() => {
    if (!displayContent) return ''
    return highlightCodeSync(displayContent, 'json')
  }, [displayContent])

  // Restore scroll position
  useEffect(() => {
    if (containerRef.current && tab.scrollPosition !== undefined) {
      containerRef.current.scrollTop = tab.scrollPosition
    }
  }, [tab.id])

  // Save scroll position
  const handleScroll = useCallback(() => {
    if (containerRef.current && onScrollChange) {
      onScrollChange(containerRef.current.scrollTop)
    }
  }, [onScrollChange])

  // Copy content
  const handleCopy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(displayContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // Open with external application
  const handleOpenExternal = async () => {
    if (!tab.path) return
    try {
      await api.openArtifact(tab.path)
    } catch (err) {
      console.error('Failed to open with external app:', err)
    }
  }

  // Count lines
  const lines = displayContent.split('\n')
  const lineCount = lines.length
  const canOpenExternal = !api.isRemoteMode() && tab.path

  // Check if JSON is valid
  const isValidJson = useMemo(() => {
    try {
      JSON.parse(content)
      return true
    } catch {
      return false
    }
  }, [content])

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">JSON</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{t('{{count}} lines', { count: lineCount })}</span>
          {!isValidJson && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="text-yellow-500">{t('Invalid JSON')}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Format toggle */}
          {isValidJson && (
            <button
              onClick={() => setIsFormatted(!isFormatted)}
              className={`p-1.5 rounded transition-colors ${
                isFormatted
                  ? 'bg-secondary text-foreground'
                  : 'hover:bg-secondary text-muted-foreground'
              }`}
              title={isFormatted ? t('Compact') : t('Format')}
            >
              <WrapText className="w-4 h-4" />
            </button>
          )}

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Copy')}
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {/* Open with external app */}
          {canOpenExternal && (
            <button
              onClick={handleOpenExternal}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Open in external application')}
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto font-mono text-sm"
      >
        <div className="flex min-h-full">
          {/* Line numbers */}
          <div className="sticky left-0 flex-shrink-0 select-none bg-background/80 backdrop-blur-sm border-r border-border/50 text-right text-muted-foreground/40 text-xs pr-3 pl-4 py-4">
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i + 1} className="leading-6">
                {i + 1}
              </div>
            ))}
          </div>

          {/* Code */}
          <pre className="flex-1 p-4 overflow-x-auto">
            <code
              className="hljs language-json"
              dangerouslySetInnerHTML={{ __html: highlightedContent }}
            />
          </pre>
        </div>
      </div>
    </div>
  )
}
