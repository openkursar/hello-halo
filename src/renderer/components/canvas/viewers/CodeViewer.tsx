/**
 * Code Viewer - Syntax highlighted code display
 *
 * Features:
 * - Syntax highlighting via highlight.js
 * - Line numbers
 * - Copy to clipboard
 * - Scroll position preservation
 * - Window maximize for fullscreen viewing
 */

import { useRef, useEffect, useState, useCallback } from 'react'
import { Copy, Check, ExternalLink } from 'lucide-react'
import { highlightCode } from '../../../lib/highlight-loader'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'

interface CodeViewerProps {
  tab: CanvasTab
  onScrollChange?: (position: number) => void
}

export function CodeViewer({ tab, onScrollChange }: CodeViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  // Restore scroll position when tab becomes active
  useEffect(() => {
    if (containerRef.current && tab.scrollPosition !== undefined) {
      containerRef.current.scrollTop = tab.scrollPosition
    }
  }, [tab.id])

  // Save scroll position on scroll
  const handleScroll = useCallback(() => {
    if (containerRef.current && onScrollChange) {
      onScrollChange(containerRef.current.scrollTop)
    }
  }, [onScrollChange])

  // Copy content to clipboard
  const handleCopy = async () => {
    if (!tab.content) return
    try {
      await navigator.clipboard.writeText(tab.content)
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

  // Highlight code
  const highlightedCode = useHighlightedCode(tab.content || '', tab.language)
  const canOpenExternal = !api.isRemoteMode() && tab.path

  // Count lines
  const lineCount = (tab.content || '').split('\n').length

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{tab.language || 'text'}</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{t('{{count}} lines', { count: lineCount })}</span>
          {tab.mimeType && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span>{tab.mimeType}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
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

      {/* Code content */}
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
              className={`hljs ${tab.language ? `language-${tab.language}` : ''}`}
              dangerouslySetInnerHTML={{ __html: highlightedCode }}
            />
          </pre>
        </div>
      </div>
    </div>
  )
}

/**
 * Hook to highlight code with lazy-loaded highlight.js
 * Loads language definitions on-demand for better performance
 */
function useHighlightedCode(code: string, language?: string): string {
  const [highlighted, setHighlighted] = useState('')

  useEffect(() => {
    if (!code) {
      setHighlighted('')
      return
    }

    // Use async highlight with language auto-loading
    let cancelled = false
    highlightCode(code, language).then(result => {
      if (!cancelled) {
        setHighlighted(result)
      }
    })

    return () => {
      cancelled = true
    }
  }, [code, language])

  return highlighted
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
