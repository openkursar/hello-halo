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

import { useState, useCallback, memo, useRef } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { highlightCodeSync } from '../../lib/highlight-loader'

interface MarkdownRendererProps {
  content: string
  className?: string
  /** Render mode: "streaming" for live token output, "static" for completed messages */
  mode?: 'streaming' | 'static'
}

// Code block with copy button
function CodeBlock({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const codeRef = useRef<HTMLElement>(null)

  // Extract language from className (format: language-xxx)
  const match = /language-(\w+)/.exec(className || '')
  const language = match ? match[1] : ''

  const handleCopy = useCallback(async () => {
    // Read text from the actual rendered DOM element
    // This correctly handles syntax highlight <span> elements
    const text = codeRef.current?.textContent || ''
    await navigator.clipboard.writeText(text.replace(/\n$/, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  // Inline code (no language class, short content)
  if (!className) {
    return (
      <code
        className="px-1.5 py-0.5 mx-0.5 bg-secondary/80 text-primary rounded text-[0.9em] font-mono whitespace-pre-wrap"
        {...props}
      >
        {children}
      </code>
    )
  }

  // Code block
  // Use theme-aware colors: dark mode uses GitHub Dark, light mode uses GitHub Light
  return (
    <div className="group relative my-3 rounded-xl overflow-hidden border border-border/50 bg-card">
      {/* Header with language and copy button */}
      <div className="flex items-center justify-between px-4 py-2 bg-secondary border-b border-border/30">
        <span className="text-xs text-muted-foreground/70 font-mono uppercase tracking-wide">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground/60
            hover:text-foreground hover:bg-white/5 [.light_&]:hover:bg-black/5 rounded-md transition-all"
          title={t('Copy code')}
        >
          {copied ? (
            <>
              <Check size={14} className="text-green-400" />
              <span className="text-green-400">{t('Copied')}</span>
            </>
          ) : (
            <>
              <Copy size={14} />
              <span className="opacity-0 group-hover:opacity-100 transition-opacity">{t('Copy')}</span>
            </>
          )}
        </button>
      </div>

      {/* Code content - highlighted via highlight.js */}
      <pre className="p-4 overflow-x-auto">
        <code
          ref={codeRef}
          className={`hljs ${language ? `language-${language}` : ''} text-sm font-mono leading-relaxed`}
          dangerouslySetInnerHTML={{ __html: highlightCodeSync(String(children).replace(/\n$/, ''), language) }}
        />
      </pre>
    </div>
  )
}

// Custom components for markdown elements
const components = {
  // Code blocks and inline code
  code: CodeBlock,

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
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
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

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className = '',
  mode = 'static',
}: MarkdownRendererProps) {
  if (!content) return null

  return (
    <div className={`markdown-content overflow-x-auto ${className}`}>
      <Streamdown
        mode={mode}
        components={components as any}
        controls={false}
      >
        {content}
      </Streamdown>
    </div>
  )
})
