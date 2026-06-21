/**
 * Store Documentation
 *
 * Lazy-loaded SKILL.md/README section for the store detail page.
 * Renders inline content immediately when the spec already carries it;
 * otherwise fetches async with a skeleton placeholder. Hidden entirely
 * when the source has no document or the fetch fails.
 */

import { useState, useEffect } from 'react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'

const TRUNCATE_THRESHOLD = 100_000

// Session-level cache so re-entering the same detail page never refetches
// or flashes the skeleton. null = source confirmed to have no document.
const documentCache = new Map<string, string | null>()
const CACHE_MAX = 30

function cacheSet(key: string, value: string | null): void {
  if (documentCache.size >= CACHE_MAX) {
    const oldest = documentCache.keys().next().value
    if (oldest !== undefined) documentCache.delete(oldest)
  }
  documentCache.set(key, value)
}

interface StoreDocumentationProps {
  slug: string
  version: string
  /** Document already present in the spec (e.g. halo source skill_files) — skips fetching */
  inlineContent?: string
}

export function StoreDocumentation({ slug, version, inlineContent }: StoreDocumentationProps) {
  const { t } = useTranslation()
  const cacheKey = `${slug}@${version}`

  const cached = inlineContent ?? documentCache.get(cacheKey)
  const [content, setContent] = useState<string | null>(cached ?? null)
  const [loading, setLoading] = useState(cached === undefined)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (inlineContent !== undefined || documentCache.has(cacheKey)) return

    let cancelled = false
    api.storeGetAppDocument(slug)
      .then(res => {
        const doc = res.success ? (res.data?.content ?? null) : null
        cacheSet(cacheKey, doc)
        if (!cancelled) {
          setContent(doc)
          setLoading(false)
        }
      })
      .catch(() => {
        cacheSet(cacheKey, null)
        if (!cancelled) {
          setContent(null)
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [slug, cacheKey, inlineContent])

  if (loading) {
    return (
      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('Documentation')}
        </h2>
        <div className="rounded-lg bg-secondary/40 border border-border/30 p-4 space-y-2.5 animate-pulse">
          <div className="h-3 w-1/3 rounded bg-secondary" />
          <div className="h-3 w-full rounded bg-secondary" />
          <div className="h-3 w-5/6 rounded bg-secondary" />
          <div className="h-3 w-2/3 rounded bg-secondary" />
        </div>
      </div>
    )
  }

  if (!content) return null

  const isTruncated = !expanded && content.length > TRUNCATE_THRESHOLD
  const displayContent = isTruncated ? content.slice(0, TRUNCATE_THRESHOLD) : content

  return (
    <div className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('Documentation')}
      </h2>
      <div className="rounded-lg bg-secondary/40 border border-border/30 p-4 overflow-x-auto">
        <MarkdownRenderer content={displayContent} mode="static" />
        {isTruncated && (
          <div className="mt-3 pt-3 border-t border-border/30">
            <button
              onClick={() => setExpanded(true)}
              className="text-xs text-primary hover:text-primary/80 transition-colors font-medium"
            >
              {t('Show full document')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
