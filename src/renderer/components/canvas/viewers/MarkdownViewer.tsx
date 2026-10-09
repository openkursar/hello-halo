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

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Copy, Check, Code, Eye, ExternalLink, Pen } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import { useCodePlugin } from '../../../lib/streamdown-plugins'
import { splitMarkdownIntoChunks } from '../../../lib/markdown-chunks'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useCanvasActions } from '../../../hooks/useCanvasLifecycle'
import { useTranslation } from '../../../i18n'
import {
  notifyRevealOutcome,
  openCommentCardAtComposer,
  openCommentCardAtTopOf,
  referenceExtension,
  revealInEditor,
  revealInElement,
  useTextReferences,
} from '../../references'
import { CodeMirrorEditor, type CodeMirrorEditorRef } from './CodeMirrorEditor'
import { countLines } from './count-lines'

/**
 * Above this size the document is rendered a viewport at a time instead of all
 * at once. Rendering the whole thing costs DOM nodes in proportion to the file,
 * so a multi-megabyte document would otherwise block the renderer for seconds
 * and hold gigabytes of nodes for as long as the tab is open.
 *
 * Everything below the threshold takes the original single-pass path unchanged
 * — chunked rendering trades a little fidelity (in-page find only reaches
 * mounted text; link reference definitions must sit in the same section that
 * uses them) and that trade is only worth making when the file is big enough to
 * hurt.
 */
const CHUNKED_RENDER_THRESHOLD_CHARS = 128_000

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

const STREAMDOWN_CONTROLS = { code: true } as const

interface MarkdownViewerProps {
  tab: CanvasTab
  onScrollChange?: (position: number) => void
  onEditRequest?: () => void
}

export function MarkdownViewer({ tab, onScrollChange, onEditRequest }: MarkdownViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  // In chunked mode Virtuoso owns the scroll container, so the scroll position
  // is read from the element it hands back rather than from `containerRef`.
  const chunkScrollerRef = useRef<HTMLElement | null>(null)
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered')
  const [copied, setCopied] = useState(false)
  const codePlugin = useCodePlugin()

  // Get the base directory of the markdown file for resolving relative paths
  const basePath = tab.path ? tab.path.substring(0, tab.path.lastIndexOf('/')) : ''

  const content = tab.content || ''
  const chunks = useMemo(
    () => (content.length > CHUNKED_RENDER_THRESHOLD_CHARS ? splitMarkdownIntoChunks(content) : null),
    [content]
  )
  const isChunked = viewMode === 'rendered' && chunks !== null && chunks.length > 1

  // ── References: the preview's text and the source's lines can be pointed at ──
  const textScopeRef = useRef<HTMLDivElement>(null)
  const sourceEditorRef = useRef<CodeMirrorEditorRef>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  useTextReferences(textScopeRef, {
    source: tab.path ? { kind: 'file', path: tab.path, precision: 'passage' } : null,
    sourceText: content,
  })
  const pathRef = useRef(tab.path)
  pathRef.current = tab.path
  const [sourceExtensions] = useState(() => [referenceExtension({
    source: () => (pathRef.current ? { kind: 'file', path: pathRef.current, precision: 'lines' } : null),
  })])
  // First source line of each chunk, to bring a chunk holding a line into the window.
  const chunkStartLines = useMemo(() => {
    if (!chunks) return null
    const starts: number[] = []
    let line = 1
    for (const chunk of chunks) {
      starts.push(line)
      line += countLines(chunk)
    }
    return starts
  }, [chunks])

  // Going back to a place: a passage is looked for in the preview; exact lines show in the source.
  const { consumeReveal } = useCanvasActions()
  const reveal = tab.reveal
  const contentReady = !tab.isLoading && tab.content !== undefined
  const revealTabIdRef = useRef(tab.id)
  revealTabIdRef.current = tab.id
  useEffect(() => {
    if (!reveal || !contentReady) return
    const finish = (outcome: 'exact' | 'moved' | 'lost') => {
      notifyRevealOutcome(outcome)
      // A passage gone from the preview: its comment opens at the top of it, to be edited all the same.
      if (outcome === 'lost' && reveal.commentId && viewMode !== 'source') {
        const place = textScopeRef.current
        if (place) openCommentCardAtTopOf(reveal.commentId, place)
        else openCommentCardAtComposer(reveal.commentId)
      }
      consumeReveal(revealTabIdRef.current, reveal.seq)
    }
    const comment = { commentId: reveal.commentId }
    if (viewMode === 'source') {
      const view = sourceEditorRef.current?.getView()
      if (!view) return
      finish(revealInEditor(view, { range: reveal.range, quote: reveal.passage ? undefined : reveal.quote, ...comment }))
      return
    }
    if (!reveal.passage && reveal.range) {
      // Lines are exact only in the source; the effect runs again once it shows.
      setViewMode('source')
      return
    }
    const scope = textScopeRef.current
    if (reveal.quote && scope && revealInElement(scope, reveal.quote, comment)) {
      finish('exact')
      return
    }
    if (isChunked && reveal.range && chunkStartLines && virtuosoRef.current) {
      let index = 0
      while (index + 1 < chunkStartLines.length && chunkStartLines[index + 1] <= reveal.range.startLine) index++
      virtuosoRef.current.scrollToIndex({ index, align: 'start' })
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
        const found = !!reveal.quote && !!textScopeRef.current && revealInElement(textScopeRef.current, reveal.quote, comment)
        finish(found ? 'exact' : 'lost')
      }))
      return () => cancelAnimationFrame(frame)
    }
    finish('lost')
  }, [reveal, contentReady, viewMode, isChunked, chunkStartLines, consumeReveal])

  // Restore scroll position on mount and on a view change (rendered/chunked
  // views only — source view's restore is handled by CodeMirrorEditor's
  // `scrollPosition` prop).
  useEffect(() => {
    if (viewMode === 'source') return
    // Chunked mode measures item heights lazily, so the target offset may not
    // exist yet on the first frame — restoring what we can is still closer than
    // jumping to the top.
    const scroller = isChunked ? chunkScrollerRef.current : containerRef.current
    if (scroller) scroller.scrollTop = tab.view.scrollPosition ?? 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, isChunked])

  // Save scroll position
  const handleScroll = useCallback(() => {
    if (containerRef.current && onScrollChange) {
      onScrollChange(containerRef.current.scrollTop)
    }
  }, [onScrollChange])

  useEffect(() => {
    if (!isChunked || !onScrollChange) return
    const el = chunkScrollerRef.current
    if (!el) return
    const onNativeScroll = () => onScrollChange(el.scrollTop)
    el.addEventListener('scroll', onNativeScroll)
    return () => el.removeEventListener('scroll', onNativeScroll)
  }, [isChunked, onScrollChange])

  const streamdownPlugins = useMemo(() => (codePlugin ? { code: codePlugin } : undefined), [codePlugin])

  // Hoisted out of the JSX: an inline object is a new identity on every render,
  // which defeats memoization inside Streamdown and costs the most in chunked
  // mode, where items re-render on every scroll.
  const markdownComponents = useMemo(
    () => ({
      table({ children }: any) {
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
    }),
    [basePath]
  )

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
              <Eye className="w-3.5 h-3.5" strokeWidth={1.5} />
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
              <Code className="w-3.5 h-3.5" strokeWidth={1.5} />
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
              <Pen className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
            </button>
          )}

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Copy')}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-green-500" strokeWidth={1.5} />
            ) : (
              <Copy className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
            )}
          </button>

          {/* Open with external app */}
          {canOpenExternal && (
            <button
              onClick={handleOpenExternal}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Open in external application')}
            >
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>

      {/* Content — one element around every view, so the preview's text stays
          registered for references across view switches (the source's editor
          numbers its own lines and is skipped there). */}
      <div ref={textScopeRef} className="flex-1 min-h-0 flex flex-col">
      {isChunked ? (
        <div className="flex-1 min-h-0">
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={chunks!}
            scrollerRef={(el) => { chunkScrollerRef.current = el as HTMLElement | null }}
            // Render a screen's worth beyond the viewport in both directions so
            // scrolling reaches already-rendered content instead of blank space.
            increaseViewportBy={{ top: 800, bottom: 800 }}
            itemContent={(index, chunk) => (
              // Each chunk gets its own `.prose` wrapper, so its first element's
              // top margin resets independently — the seam between chunks won't
              // match the single-document spacing exactly (a heading-led chunk
              // sits tighter than a paragraph-led one). Known trade-off of
              // per-chunk rendering; not a bug to chase by retuning `pt-6`.
              <div className={`prose prose-invert max-w-none px-6 sm:px-8 ${index === 0 ? 'pt-6 sm:pt-8' : 'pt-6'}`}>
                <Streamdown
                  mode="static"
                  controls={STREAMDOWN_CONTROLS}
                  plugins={streamdownPlugins}
                  components={markdownComponents}
                >
                  {chunk}
                </Streamdown>
              </div>
            )}
            components={{ Footer: () => <div className="h-6 sm:h-8" /> }}
          />
        </div>
      ) : viewMode === 'rendered' ? (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-auto"
        >
          <div className="prose prose-invert max-w-none p-6 sm:p-8">
            <Streamdown
              mode="static"
              controls={STREAMDOWN_CONTROLS}
              plugins={streamdownPlugins}
              components={markdownComponents}
            >
              {content}
            </Streamdown>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <CodeMirrorEditor
            ref={sourceEditorRef}
            content={content}
            language="markdown"
            readOnly
            onScroll={onScrollChange}
            scrollPosition={tab.view.scrollPosition}
            extensions={sourceExtensions}
          />
        </div>
      )}
      </div>
    </div>
  )
}
