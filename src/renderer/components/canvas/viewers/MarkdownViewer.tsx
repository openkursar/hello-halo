/**
 * Markdown Viewer - Rendered markdown with source toggle
 *
 * Features:
 * - Beautiful markdown rendering
 * - Toggle between rendered and source view
 * - Code block syntax highlighting
 * - Copy to clipboard
 * - Window maximize for fullscreen viewing
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { Copy, Check, Code, Eye, ExternalLink, Pencil } from 'lucide-react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import { useCodePlugin } from '../../../lib/streamdown-plugins'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'

/**
 * Resolve relative image paths to halo-file:// protocol URLs
 * This bypasses cross-origin restrictions in dev mode (http://localhost -> file://)
 */
function resolveImageSrc(src: string | undefined, basePath: string): string {
  if (!src) return ''

  // Keep absolute URLs and data URIs as-is
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return src
  }

  // No base path available, return original
  if (!basePath) return src

  // Resolve relative paths to halo-file:// protocol
  if (src.startsWith('./')) {
    return `halo-file://${basePath}/${src.slice(2)}`
  }

  if (src.startsWith('../')) {
    const parts = basePath.split('/')
    const srcParts = src.split('/')
    while (srcParts[0] === '..') {
      parts.pop()
      srcParts.shift()
    }
    return `halo-file://${parts.join('/')}/${srcParts.join('/')}`
  }

  if (src.startsWith('/')) {
    return `halo-file://${src}`
  }

  // Relative path without prefix
  return `halo-file://${basePath}/${src}`
}

interface MarkdownViewerProps {
  tab: CanvasTab
  onScrollChange?: (position: number) => void
  onEditRequest?: () => void
}

export function MarkdownViewer({ tab, onScrollChange, onEditRequest }: MarkdownViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered')
  const [copied, setCopied] = useState(false)
  const codePlugin = useCodePlugin()

  // Get the base directory of the markdown file for resolving relative paths
  const basePath = tab.path ? tab.path.substring(0, tab.path.lastIndexOf('/')) : ''

  // Restore scroll position
  useEffect(() => {
    if (containerRef.current && tab.scrollPosition !== undefined) {
      containerRef.current.scrollTop = tab.scrollPosition
    }
  }, [tab.id, viewMode])

  // Save scroll position
  const handleScroll = useCallback(() => {
    if (containerRef.current && onScrollChange) {
      onScrollChange(containerRef.current.scrollTop)
    }
  }, [onScrollChange])

  // Copy content
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

  const content = tab.content || ''
  const canOpenExternal = !api.isRemoteMode() && tab.path

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex items-center rounded-md bg-secondary/50 p-0.5">
            <button
              onClick={() => setViewMode('rendered')}
              className={`
                flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors
                ${viewMode === 'rendered'
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
        </div>

        <div className="flex items-center gap-1">
          {/* Edit button */}
          {onEditRequest && (
            <button
              onClick={onEditRequest}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Edit')}
            >
              <Pencil className="w-4 h-4 text-muted-foreground" />
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
        className="flex-1 overflow-auto"
      >
        {viewMode === 'rendered' ? (
          <div className="prose prose-invert max-w-none p-6 sm:p-8">
            <Streamdown
              mode="static"
              controls={{ code: true }}
              plugins={codePlugin ? { code: codePlugin } : undefined}
              components={{
                // Style tables
                table({ children }) {
                  return (
                    <div className="overflow-x-auto">
                      <table className="min-w-full">{children}</table>
                    </div>
                  )
                },
                // Links - add target="_blank" (styling from tailwind.config.cjs)
                a({ href, children }: any) {
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  )
                },
                // Style images - resolve relative paths using halo-file:// protocol
                img({ src, alt }: any) {
                  return (
                    <img
                      src={resolveImageSrc(src, basePath)}
                      alt={alt}
                      className="h-auto rounded-lg"
                      // Don't stretch small images, limit large ones (like GitHub ~880px)
                      style={{ maxWidth: 'min(100%, 880px)' }}
                    />
                  )
                }
              }}
            >
              {content}
            </Streamdown>
          </div>
        ) : (
          <SourceView content={content} />
        )}
      </div>
    </div>
  )
}

/**
 * Source code view with line numbers
 */
function SourceView({ content }: { content: string }) {
  const lines = content.split('\n')

  return (
    <div className="flex font-mono text-sm">
      {/* Line numbers */}
      <div className="sticky left-0 flex-shrink-0 select-none bg-background/80 backdrop-blur-sm border-r border-border/50 text-right text-muted-foreground/40 pr-3 pl-4 py-4 leading-6">
        {lines.map((_, i) => (
          <div key={i + 1}>
            {i + 1}
          </div>
        ))}
      </div>

      {/* Content */}
      <pre className="flex-1 py-4 pl-4 pr-4 overflow-x-auto whitespace-pre-wrap break-words leading-6 m-0">
        {content}
      </pre>
    </div>
  )
}
