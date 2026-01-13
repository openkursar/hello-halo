/**
 * Text Viewer - Plain text display with line numbers
 *
 * Features:
 * - Simple text display
 * - Line numbers
 * - Copy to clipboard
 * - Word wrap toggle
 * - Window maximize for fullscreen viewing
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { Copy, Check, ExternalLink, WrapText } from 'lucide-react'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'

interface TextViewerProps {
  tab: CanvasTab
  onScrollChange?: (position: number) => void
}

export function TextViewer({ tab, onScrollChange }: TextViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [wordWrap, setWordWrap] = useState(true)

  const content = tab.content || ''

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
      await navigator.clipboard.writeText(content)
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
  const lines = content.split('\n')
  const lineCount = lines.length
  const canOpenExternal = !api.isRemoteMode() && tab.path

  // Calculate file size
  const fileSize = new Blob([content]).size
  const formattedSize = fileSize < 1024
    ? `${fileSize} B`
    : fileSize < 1024 * 1024
    ? `${(fileSize / 1024).toFixed(1)} KB`
    : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">text</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{t('{{count}} lines', { count: lineCount })}</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{formattedSize}</span>
        </div>

        <div className="flex items-center gap-1">
          {/* Word wrap toggle */}
          <button
            onClick={() => setWordWrap(!wordWrap)}
            className={`p-1.5 rounded transition-colors ${
              wordWrap
                ? 'bg-secondary text-foreground'
                : 'hover:bg-secondary text-muted-foreground'
            }`}
            title={wordWrap ? t('Disable wrap') : t('Enable wrap')}
          >
            <WrapText className="w-4 h-4" />
          </button>

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
            {lines.map((_, i) => (
              <div key={i + 1} className="leading-6">
                {i + 1}
              </div>
            ))}
          </div>

          {/* Content */}
          <pre
            className={`flex-1 p-4 ${
              wordWrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'
            }`}
          >
            {content}
          </pre>
        </div>
      </div>
    </div>
  )
}
