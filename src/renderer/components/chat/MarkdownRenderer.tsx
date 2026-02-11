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

import { memo } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import { useCodePlugin } from '../../lib/streamdown-plugins'

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
  const codePlugin = useCodePlugin()

  if (!content) return null

  return (
    <div className={`markdown-content overflow-x-auto ${className}`}>
      <Streamdown
        mode={mode}
        components={components as any}
        controls={{ code: true }}
        plugins={codePlugin ? { code: codePlugin } : undefined}
      >
        {content}
      </Streamdown>
    </div>
  )
})
