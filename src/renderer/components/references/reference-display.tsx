/**
 * How a reference is named and drawn wherever it appears: the chips' lists,
 * comment cards, the comment box header, tooltips. The wording lives here
 * (the shared module stays wording-free), so every surface says the same
 * thing.
 */

import { FileCode, FileText, Folder, GitCompare, MessageSquareText, SquareTerminal } from 'lucide-react'
import type { TFunction } from 'i18next'
import { displayPath, isQuoteAtLimit, quoteCharLimit, referenceLocation, referenceLocationText } from '../../../shared/content-reference'
import type { ContentReference } from '../../../shared/types/content-reference'

/** A reference, or a draft of one; labels never need the id. */
export type ReferenceLike = Omit<ContentReference, 'id'>

/** The card label: "a.ts:45-48", "a.ts:12 · After", "Terminal · zsh", "Reply · <title>", "site/". */
export function referenceLabel(ref: ReferenceLike, t: TFunction): string {
  const { source } = ref
  switch (source.kind) {
    case 'file':
      return referenceLocationText(ref as ContentReference)
    case 'diff': {
      const location = referenceLocationText(ref as ContentReference)
      return source.side === 'before'
        ? t('{{location}} · Before', { location })
        : t('{{location}} · After', { location })
    }
    case 'terminal':
      return t('Terminal · {{title}}', { title: source.title })
    case 'message': {
      const title = source.conversationTitle
      if (source.whole) return title ? t('Full reply · {{title}}', { title }) : t('Full reply')
      return title ? t('Reply · {{title}}', { title }) : t('AI reply')
    }
    case 'path': {
      const { name } = referenceLocation(ref as ContentReference)
      return source.isDirectory ? `${name}/` : name
    }
  }
}

/**
 * Hover text for a card: where it points in full, the start of the excerpt,
 * and whether the excerpt was cut to its limit.
 */
export function referenceTooltip(ref: ReferenceLike, t: TFunction, baseDir?: string): string {
  const { source } = ref
  const lines: string[] = []
  if (source.kind === 'file' || source.kind === 'diff' || source.kind === 'path') {
    const location = referenceLocation(ref as ContentReference, baseDir)
    lines.push(location.lines ? `${displayPath(source.path, baseDir)}:${location.lines}` : displayPath(source.path, baseDir))
  } else {
    lines.push(referenceLabel(ref, t))
  }
  if (ref.quote) {
    const excerpt = ref.quote.length > TOOLTIP_EXCERPT_CHARS ? `${ref.quote.slice(0, TOOLTIP_EXCERPT_CHARS)}…` : ref.quote
    lines.push('', excerpt)
    if (isQuoteAtLimit(source.kind, ref.quote)) {
      lines.push('', t('Excerpt shortened to {{count}} characters', { count: quoteCharLimit(source.kind) }))
    }
  }
  return lines.join('\n')
}

const TOOLTIP_EXCERPT_CHARS = 280

export function ReferenceKindIcon({ reference, size = 13, className = '' }: { reference: ReferenceLike; size?: number; className?: string }) {
  const { source } = reference
  const props = { size, className: `shrink-0 ${className}`, 'aria-hidden': true as const }
  switch (source.kind) {
    case 'file':
      return <FileCode {...props} />
    case 'diff':
      return <GitCompare {...props} />
    case 'terminal':
      return <SquareTerminal {...props} />
    case 'message':
      return <MessageSquareText {...props} />
    case 'path':
      return source.isDirectory ? <Folder {...props} /> : <FileText {...props} />
  }
}

/** A comment card's header: "Comment · lines 11–12", "Comment · line 4 · After", or "Comment" without lines. */
export function commentHeader(ref: ReferenceLike, t: TFunction): string {
  const range = ref.range
  const header = !range
    ? t('Comment')
    : range.startLine === range.endLine
      ? t('Comment · line {{line}}', { line: range.startLine })
      : t('Comment · lines {{start}}–{{end}}', { start: range.startLine, end: range.endLine })
  if (ref.source.kind !== 'diff') return header
  return ref.source.side === 'before' ? t('{{header}} · Before', { header }) : t('{{header}} · After', { header })
}

/** The first line of a reference's excerpt, as a selection is listed. */
export function quoteFirstLine(ref: ReferenceLike): string {
  const quote = ref.quote ?? ''
  const first = quote.split('\n').find(line => line.trim()) ?? ''
  return first.trim()
}
