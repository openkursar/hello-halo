/**
 * MarkdownRenderer - High-performance markdown rendering for AI messages
 * Uses Streamdown (Vercel) for optimized streaming + static rendering
 *
 * Key improvements over react-markdown:
 * - Incremental DOM updates during streaming (not full reparse)
 * - Automatic handling of unterminated markdown (incomplete code blocks, etc.)
 * - Built-in streaming cursor / caret support
 * - ~8x faster first-paint on large documents
 */

import { memo, useContext, useMemo, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { Streamdown, defaultRehypePlugins } from 'streamdown'
import type { PluginConfig } from 'streamdown'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import { useCodePlugin, useMathPlugin } from '../../lib/streamdown-plugins'
import { createStreamingMarkdown } from '../../lib/streaming-markdown'
import { useTranslation } from '../../i18n'
import { OpenTableContext } from './open-table-context'
import { fileLinkHandlers, rehypeFileMentions, rehypeLocalFileLinks, rehypeRestoreFileLinks, useFileLinkOptions, useFileMentionLinks } from '../references'

function tableToCsv(table: HTMLTableElement): string {
  return Array.from(table.rows)
    .map(row => Array.from(row.cells)
      .map(cell => {
        const text = cell.innerText.trim()
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
      })
      .join(','))
    .join('\n')
}

function TableBlock({ children }: { children?: React.ReactNode }) {
  const { t } = useTranslation()
  const openTable = useContext(OpenTableContext)
  const tableRef = useRef<HTMLTableElement>(null)

  return (
    <div className="group/table relative my-3">
      <div className="overflow-x-auto rounded-lg border border-border/50">
        <table ref={tableRef} className="w-full text-sm">{children}</table>
      </div>
      {openTable && (
        <button
          type="button"
          onClick={() => { if (tableRef.current) openTable(tableToCsv(tableRef.current)) }}
          title={t('Open in canvas')}
          aria-label={t('Open in canvas')}
          className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground opacity-0 transition-opacity ease-halo hover:text-foreground focus-visible:opacity-100 group-hover/table:opacity-100"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

interface MarkdownRendererProps {
  content: string
  className?: string
  /** Render mode: "streaming" for live token output, "static" for completed messages */
  mode?: 'streaming' | 'static'
}

// Custom components for markdown elements
const components = {

  // Paragraphs
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>
  ),

  // Headings
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-xl font-semibold mt-6 mb-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-lg font-semibold mt-5 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-base font-semibold mt-4 mb-2 first:mt-0">{children}</h3>
  ),

  // Lists
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-3 pl-5 space-y-1 list-disc marker:text-muted-foreground/50">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-3 pl-5 space-y-1 list-decimal marker:text-muted-foreground/50">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="leading-relaxed">{children}</li>
  ),

  // Blockquote
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-3 pl-4 border-l-2 border-primary/40 text-muted-foreground italic">
      {children}
    </blockquote>
  ),

  // Links
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline underline-offset-2"
    >
      {children}
    </a>
  ),

  // Tables
  table: ({ children }: { children?: React.ReactNode }) => <TableBlock>{children}</TableBlock>,
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-secondary/50">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-4 py-2 text-left font-medium border-b border-border/50">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-4 py-2 border-b border-border/30">{children}</td>
  ),

  // Horizontal rule
  hr: () => <hr className="my-6 border-border/50" />,

  // Strong and emphasis
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic">{children}</em>
  ),

  // Strikethrough
  del: ({ children }: { children?: React.ReactNode }) => (
    <del className="text-muted-foreground line-through">{children}</del>
  ),

  // Task list items (GFM)
  input: ({ checked, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      type="checkbox"
      checked={checked}
      readOnly
      className="mr-2 rounded border-muted-foreground/30 text-primary focus:ring-primary/30"
      {...props}
    />
  ),
}

// Streamdown memoizes its context on these identities; inline literals would
// re-render every code block, link and table on each parent render.
const CONTROLS = { code: true } as const
const LINK_SAFETY = { enabled: true } as const
// File targets become inert before URL hardening; HTML still passes the unchanged sanitizer.
const FILE_LINK_REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  rehypeLocalFileLinks,
  defaultRehypePlugins.sanitize,
  rehypeRestoreFileLinks,
  defaultRehypePlugins.harden,
]
const FILE_MENTION_REHYPE_PLUGINS = [...FILE_LINK_REHYPE_PLUGINS, rehypeFileMentions]

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className = '',
  mode = 'static',
}: MarkdownRendererProps) {
  const codePlugin = useCodePlugin()
  const mathPlugin = useMathPlugin()
  const streaming = mode === 'streaming'

  // Streaming code stays monochrome: highlighting re-tokenizes the whole block
  // on every delta. The finished message renders static and highlights once.
  const plugins = useMemo<PluginConfig>(() => {
    const config: PluginConfig = {}
    if (codePlugin && !streaming) config.code = codePlugin
    if (mathPlugin) config.math = mathPlugin
    return config
  }, [codePlugin, mathPlugin, streaming])

  // Mending and block lexing follow the open tail of the reply, not all of it.
  const [streamingParser] = useState(createStreamingMarkdown)
  const markdown = useMemo(
    () => (streaming ? streamingParser.update(content).markdown : content),
    [content, streaming, streamingParser],
  )

  // File mentions become links only where a provider asks for them, and only
  // once the reply is complete — a streaming reply is never checked.
  const providedFileLinks = useFileLinkOptions()
  const fileLinks = streaming ? null : providedFileLinks
  const containerRef = useRef<HTMLDivElement>(null)
  useFileMentionLinks(containerRef, markdown, fileLinks)

  if (!content) return null

  return (
    <div ref={containerRef} className={`markdown-content overflow-x-auto ${className}`} {...fileLinkHandlers(fileLinks)}>
      <Streamdown
        mode={mode}
        parseIncompleteMarkdown={false}
        parseMarkdownIntoBlocksFn={streaming ? streamingParser.parseBlocks : undefined}
        components={components as any}
        controls={CONTROLS}
        linkSafety={LINK_SAFETY}
        plugins={plugins}
        rehypePlugins={providedFileLinks ? (streaming ? FILE_LINK_REHYPE_PLUGINS : FILE_MENTION_REHYPE_PLUGINS) : undefined}
      >
        {markdown}
      </Streamdown>
    </div>
  )
})
