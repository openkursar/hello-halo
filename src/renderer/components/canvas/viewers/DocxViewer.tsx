/**
 * Word document viewer for .docx tabs, rendered with docx-preview. Pages keep
 * the familiar white-sheet look on top of the theme background (docx-preview's
 * own gray wrapper background is overridden so dark mode shows through).
 */

import { useState, useRef, useEffect } from 'react'
import { renderAsync } from 'docx-preview'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'
import { OfficeFallback } from './OfficeFallback'

interface DocxViewerProps {
  tab: CanvasTab
  onScrollChange?: (position: number) => void
}

export default function DocxViewer({ tab, onScrollChange }: DocxViewerProps) {
  const { t } = useTranslation()
  const bytes = tab.bytes
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [rendering, setRendering] = useState(true)
  const [renderError, setRenderError] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!bytes || !container) return
    let cancelled = false
    setRendering(true)
    setRenderError(false)

    renderAsync(bytes, container, undefined, {
      inWrapper: true,
      ignoreLastRenderedPageBreak: false
    })
      .then(() => {
        if (!cancelled) setRendering(false)
      })
      .catch((err) => {
        console.error('[DocxViewer] Failed to render document:', err)
        if (!cancelled) {
          setRendering(false)
          setRenderError(true)
        }
      })

    return () => {
      cancelled = true
      container.innerHTML = ''
    }
  }, [bytes])

  useEffect(() => {
    if (rendering || !scrollerRef.current) return
    scrollerRef.current.scrollTop = tab.scrollPosition ?? 0
  }, [tab.id, rendering])

  useEffect(() => {
    if (!onScrollChange) return
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => onScrollChange(el.scrollTop)
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [onScrollChange])

  if (tab.error || (!bytes && !tab.isLoading)) {
    return (
      <OfficeFallback
        tab={tab}
        title={t('Unable to preview this document')}
        detail={tab.error || t('The file could not be read.')}
      />
    )
  }

  if (renderError) {
    return (
      <OfficeFallback
        tab={tab}
        title={t('Unable to preview this document')}
        detail={t('The file may be corrupt or in an unsupported format.')}
      />
    )
  }

  return (
    <div className="relative h-full bg-muted/30">
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      )}
      <div
        ref={scrollerRef}
        className="h-full overflow-auto"
      >
        {/* docx-preview injects white page sections; make its wrapper
            transparent so the theme background frames the pages, and let
            pages shrink on narrow screens instead of forcing overflow. */}
        <div
          ref={containerRef}
          className="[&_.docx-wrapper]:!bg-transparent [&_.docx-wrapper]:!p-4 sm:[&_.docx-wrapper]:!p-8 [&_.docx-wrapper>section.docx]:!shadow-md [&_.docx-wrapper>section.docx]:max-w-full [&_.docx-wrapper>section.docx]:box-border"
        />
      </div>
    </div>
  )
}
