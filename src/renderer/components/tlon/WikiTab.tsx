/**
 * WikiTab — read-only view of the AI-generated notes ("AI Notes").
 *
 * Left: the rebuilt index plus a list of wiki pages.
 * Right (or pushed view on mobile): the selected page rendered as Markdown.
 * [[wikilink]] references are rewritten to clickable links that open the
 * matching page.
 */

import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from '../../i18n'
import { useTlonStore } from '../../stores/tlon.store'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { NotebookText, ChevronLeft, FileText } from 'lucide-react'
import type { KnowledgeBaseEntry, WikiPageMeta } from '../../../shared/types/tlon'

interface WikiTabProps {
  kb: KnowledgeBaseEntry
}

/** Resolve a [[wikilink]] target to a known page path. */
function resolveWikiLink(target: string, pages: WikiPageMeta[]): WikiPageMeta | undefined {
  const normalized = target.trim().toLowerCase()
  return pages.find(p =>
    p.title.toLowerCase() === normalized ||
    p.path.toLowerCase() === normalized ||
    p.path.toLowerCase().replace(/\.md$/, '') === normalized
  )
}

/** Replace [[wikilink]] with a placeholder link so MarkdownRenderer can render it. */
function rewriteWikiLinks(content: string, pages: WikiPageMeta[]): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => {
    const page = resolveWikiLink(target, pages)
    if (page) return `[${target}](#wiki:${encodeURIComponent(page.path)})`
    return `[${target}](#)`
  })
}

export function WikiTab({ kb }: WikiTabProps) {
  const { t } = useTranslation()
  const wikiPages = useTlonStore(s => s.wikiPages[kb.id]) ?? []
  const indexContent = useTlonStore(s => s.indexContent[kb.id]) ?? ''
  const readWikiPage = useTlonStore(s => s.readWikiPage)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [pageContent, setPageContent] = useState<string>('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!selectedPath) {
      setPageContent('')
      return
    }
    setLoading(true)
    readWikiPage(kb.id, selectedPath).then(content => {
      if (!cancelled) {
        setPageContent(content ?? t('Could not load this note.'))
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [selectedPath, kb.id, readWikiPage, t])

  const renderedContent = useMemo(
    () => rewriteWikiLinks(pageContent, wikiPages),
    [pageContent, wikiPages]
  )

  // Intercept clicks on rewritten wiki links to navigate in-place.
  const handleContentClick = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    if (href.startsWith('#wiki:')) {
      e.preventDefault()
      setSelectedPath(decodeURIComponent(href.slice('#wiki:'.length)))
    }
  }

  if (wikiPages.length === 0) {
    return (
      <div className="p-6 sm:p-10 text-center">
        <NotebookText className="w-7 h-7 mx-auto text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">{t('No notes yet')}</p>
        <p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">
          {t('Add files and let Halo learn them — the notes it writes will appear here.')}
        </p>
      </div>
    )
  }

  // Page reader (pushed on top of the list)
  if (selectedPath) {
    const meta = wikiPages.find(p => p.path === selectedPath)
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-border flex-shrink-0">
          <button
            onClick={() => setSelectedPath(null)}
            className="flex items-center gap-1 text-sm text-primary hover:text-primary/80 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            {t('All notes')}
          </button>
          <span className="text-sm font-medium truncate">{meta?.title ?? selectedPath}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 sm:p-5" onClick={handleContentClick}>
          {loading
            ? <p className="text-sm text-muted-foreground">{t('Loading…')}</p>
            : <MarkdownRenderer content={renderedContent} />}
        </div>
      </div>
    )
  }

  // Index + page list
  return (
    <div className="p-3 sm:p-4 space-y-4">
      {indexContent.trim() && (
        <div className="rounded-xl border border-border bg-muted/30 p-3 sm:p-4">
          <MarkdownRenderer content={indexContent} />
        </div>
      )}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
          {t('Notes')}
        </h4>
        <div className="space-y-1">
          {wikiPages.map(page => (
            <button
              key={page.path}
              onClick={() => setSelectedPath(page.path)}
              className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card hover:bg-secondary transition-colors"
            >
              <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm truncate flex-1">{page.title}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
