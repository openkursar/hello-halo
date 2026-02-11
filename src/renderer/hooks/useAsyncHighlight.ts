/**
 * useAsyncHighlight - Non-blocking syntax highlighting hook
 *
 * Renders plain text immediately, then replaces with highlighted HTML
 * asynchronously via requestAnimationFrame. This eliminates the
 * synchronous highlight.js bottleneck that causes UI jank on expand.
 *
 * Flow:
 * 1. Return escaped plain text instantly (zero delay)
 * 2. Schedule highlight in next idle frame
 * 3. Swap in highlighted HTML when ready
 */

import { useState, useEffect, useRef } from 'react'
import { highlightCode } from '../lib/highlight-loader'

// Simple HTML escape for plain text fallback
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Returns highlighted HTML for the given code string.
 * Initially returns escaped plain text, then async-updates with
 * syntax-highlighted HTML once highlight.js finishes.
 */
export function useAsyncHighlight(code: string, language?: string): string {
  const [html, setHtml] = useState(() => escapeHtml(code))
  const rafRef = useRef<number>(0)
  const currentKeyRef = useRef('')

  useEffect(() => {
    if (!code) {
      setHtml('')
      return
    }

    // Dedupe: skip if inputs haven't actually changed
    const key = `${language}:${code}`
    if (key === currentKeyRef.current) return
    currentKeyRef.current = key

    // Immediately show plain text (no jank)
    setHtml(escapeHtml(code))

    // Cancel any pending highlight from previous render
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }

    // Guard against setState after unmount (RAF fires but Promise resolves post-cleanup)
    let cancelled = false

    // Schedule async highlight — yields to browser for paint first
    rafRef.current = requestAnimationFrame(() => {
      highlightCode(code, language).then((highlighted) => {
        // Only apply if this is still the current request and not cancelled
        if (!cancelled && currentKeyRef.current === key) {
          setHtml(highlighted)
        }
      })
    })

    return () => {
      cancelled = true
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [code, language])

  return html
}
