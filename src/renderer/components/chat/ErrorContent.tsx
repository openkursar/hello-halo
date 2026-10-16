/**
 * ErrorContent — Production-grade error message renderer for thought timelines.
 *
 * Used by the thought panel (live and history alike) when rendering thoughts
 * of type 'error'. Provides:
 * - Generous default preview (errors are critical info, not chatter)
 * - Expand/collapse for very long errors
 * - One-click copy of the full raw error message
 * - JSON pretty-print when an embedded payload is detected
 *
 * Visual treatment intentionally subdued (foreground tones rather than red
 * fills) — the surrounding thought-timeline card already signals "error"
 * via icon and header label. Repainting the body red would shout.
 */

import { useState, useCallback, useMemo } from 'react'
import { Copy, Check } from 'lucide-react'
import { useTranslation } from '../../i18n'

/** Show up to this many characters before offering an expand toggle. */
const PREVIEW_CHAR_LIMIT = 600

interface ErrorContentProps {
  content: string
}

/**
 * Detect and pretty-print an embedded JSON payload inside an error string.
 *
 * Provider errors typically arrive as `<prefix> {json…}` (e.g.
 * `API Error: 429 {"error":{"message":"…"}}`). We locate the first JSON-ish
 * delimiter, then progressively trim trailing characters until JSON.parse
 * succeeds — robust against trailing log noise.
 *
 * Returns null when no parseable JSON is found.
 */
function tryFormatJson(text: string): { prefix: string; json: string; suffix: string } | null {
  const start = text.search(/[{[]/)
  if (start === -1) return null

  const candidate = text.slice(start)
  // Cap the search to avoid pathological cost on huge non-JSON strings
  const maxLen = Math.min(candidate.length, 32_000)

  for (let end = maxLen; end > 1; end--) {
    const slice = candidate.slice(0, end)
    try {
      const parsed = JSON.parse(slice)
      // Guard against trivial scalars (e.g. just `{` parsed as something odd)
      if (typeof parsed !== 'object' || parsed === null) continue
      return {
        prefix: text.slice(0, start).trim(),
        json: JSON.stringify(parsed, null, 2),
        suffix: candidate.slice(end).trim(),
      }
    } catch {
      // keep shrinking
    }
  }
  return null
}

export function ErrorContent({ content }: ErrorContentProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const trimmed = content ?? ''
  const isLong = trimmed.length > PREVIEW_CHAR_LIMIT
  const showFull = isExpanded || !isLong

  // Only pay the JSON parse cost when actually showing the full content.
  const formatted = useMemo(() => {
    if (!showFull) return null
    return tryFormatJson(trimmed)
  }, [showFull, trimmed])

  const previewText = isLong ? trimmed.slice(0, PREVIEW_CHAR_LIMIT) + '…' : trimmed

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trimmed)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (err) {
      // Clipboard can fail under restricted contexts (older webviews, denied perms).
      // Surfacing a UI error would over-promise; just log so the issue is diagnosable.
      console.warn('[ErrorContent] Copy failed:', err)
    }
  }, [trimmed])

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {showFull && formatted ? (
        <>
          {formatted.prefix && (
            <div className="text-sm text-foreground/85 whitespace-pre-wrap break-words">
              {formatted.prefix}
            </div>
          )}
          <pre
            className="text-sm text-foreground/85 bg-muted/40 border border-border/40 rounded-md px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-words font-mono leading-relaxed"
          >
            {formatted.json}
          </pre>
          {formatted.suffix && (
            <div className="text-sm text-foreground/85 whitespace-pre-wrap break-words">
              {formatted.suffix}
            </div>
          )}
        </>
      ) : (
        <div className="text-sm text-foreground/85 whitespace-pre-wrap break-words">
          {showFull ? trimmed : previewText}
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px]">
        {isLong && (
          <button
            type="button"
            onClick={() => setIsExpanded(v => !v)}
            className="text-primary/70 hover:text-primary transition-colors"
          >
            {isExpanded ? t('Collapse') : t('Expand full error')}
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors"
          title={t('Copy error message')}
          aria-label={t('Copy error message')}
        >
          {copied ? (
            <>
              <Check size={11} />
              <span>{t('Copied')}</span>
            </>
          ) : (
            <>
              <Copy size={11} />
              <span>{t('Copy')}</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
