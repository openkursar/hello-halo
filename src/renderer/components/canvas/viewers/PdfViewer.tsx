/**
 * PDF viewer backed by pdfjs-dist, used in remote/web mode where the desktop
 * BrowserView (Chromium's native PDF viewer) is unavailable. Single-page view
 * with page navigation and zoom; default zoom fits the page width to the
 * container.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'
import { OfficeFallback } from './OfficeFallback'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

interface PdfViewerProps {
  tab: CanvasTab
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

/**
 * Runtime asset dirs pdf.js fetches on demand, mirrored next to the renderer
 * bundle by the `halo-pdfjs-assets` build plugin. Document-relative so the same
 * paths work under the dev server, the packaged page and the remote server.
 * Omitting cMapUrl is what makes a CJK PDF without embedded fonts render blank,
 * so these are not optional for a Chinese-first product.
 */
const PDFJS_ASSETS = {
  cMapUrl: 'pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'pdfjs/standard_fonts/',
  wasmUrl: 'pdfjs/wasm/',
  iccUrl: 'pdfjs/iccs/',
} as const

export default function PdfViewer({ tab }: PdfViewerProps) {
  const { t } = useTranslation()
  const bytes = tab.bytes
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageNum, setPageNum] = useState(1)
  /** Multiplier on top of the fit-width scale; 1 = fit width. */
  const [zoom, setZoom] = useState(1)
  const [containerWidth, setContainerWidth] = useState(0)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!bytes) return
    setDoc(null)
    setLoadError(false)

    // pdfjs takes ownership of the buffer; hand it a copy so the tab keeps its
    // own bytes usable after a refresh or reopen
    const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_ASSETS })
    let cancelled = false
    loadingTask.promise
      .then((loaded) => {
        if (cancelled) return
        setDoc(loaded)
        setPageNum((p) => Math.min(p, loaded.numPages))
      })
      .catch((err) => {
        console.error('[PdfViewer] Failed to load PDF:', err)
        if (!cancelled) setLoadError(true)
      })

    return () => {
      cancelled = true
      loadingTask.destroy()
    }
  }, [bytes])

  // Track container width for fit-width scaling
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setContainerWidth(el.clientWidth))
    observer.observe(el)
    setContainerWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!doc || !canvas || containerWidth === 0) return
    let cancelled = false

    doc.getPage(pageNum).then((page) => {
      if (cancelled) return
      renderTaskRef.current?.cancel()

      const baseViewport = page.getViewport({ scale: 1 })
      // 32px horizontal padding budget around the page
      const fitScale = Math.max(0.1, (containerWidth - 32) / baseViewport.width)
      const scale = fitScale * zoom
      const dpr = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: scale * dpr })

      canvas.width = viewport.width
      canvas.height = viewport.height
      canvas.style.width = `${viewport.width / dpr}px`
      canvas.style.height = `${viewport.height / dpr}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const task = page.render({ canvasContext: ctx, viewport, canvas })
      renderTaskRef.current = task
      task.promise.catch((err) => {
        // Cancellation is expected when zoom/page changes quickly
        if (err?.name !== 'RenderingCancelledException') {
          console.error('[PdfViewer] Failed to render page:', err)
        }
      })
    })

    return () => {
      cancelled = true
      // `cancelled` only stops work that has not started; a render already in
      // flight keeps painting into a canvas that is no longer in the document.
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [doc, pageNum, zoom, containerWidth])

  const goTo = useCallback(
    (delta: number) => {
      if (!doc) return
      setPageNum((p) => Math.min(doc.numPages, Math.max(1, p + delta)))
    },
    [doc]
  )

  if (tab.error || (!bytes && !tab.isLoading)) {
    return (
      <OfficeFallback
        tab={tab}
        title={t('Unable to preview this PDF')}
        detail={tab.error || t('The file could not be read.')}
      />
    )
  }

  if (loadError) {
    return (
      <OfficeFallback
        tab={tab}
        title={t('Unable to preview this PDF')}
        detail={t('The file may be corrupt or in an unsupported format.')}
      />
    )
  }

  return (
    <div className="flex flex-col h-full bg-muted/30">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-1">
          <button
            onClick={() => goTo(-1)}
            disabled={!doc || pageNum <= 1}
            className="p-1.5 rounded hover:bg-secondary transition-colors disabled:opacity-40 disabled:pointer-events-none"
            title={t('Previous page')}
          >
            <ChevronLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          <span className="text-xs text-muted-foreground tabular-nums px-1">
            {doc ? t('{{current}} / {{total}}', { current: pageNum, total: doc.numPages }) : '—'}
          </span>
          <button
            onClick={() => goTo(1)}
            disabled={!doc || pageNum >= doc.numPages}
            className="p-1.5 rounded hover:bg-secondary transition-colors disabled:opacity-40 disabled:pointer-events-none"
            title={t('Next page')}
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))}
            disabled={zoom <= MIN_ZOOM}
            className="p-1.5 rounded hover:bg-secondary transition-colors disabled:opacity-40 disabled:pointer-events-none"
            title={t('Zoom out')}
          >
            <ZoomOut className="w-4 h-4 text-muted-foreground" />
          </button>
          <span className="text-xs text-muted-foreground tabular-nums w-10 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.25))}
            disabled={zoom >= MAX_ZOOM}
            className="p-1.5 rounded hover:bg-secondary transition-colors disabled:opacity-40 disabled:pointer-events-none"
            title={t('Zoom in')}
          >
            <ZoomIn className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={() => setZoom(1)}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Fit width')}
          >
            <Maximize className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Page */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        {!doc ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : (
          <div className="flex justify-center p-4">
            {/* bg-white is the page, not a theme choice: pdf.js paints content
                onto transparency and never fills the sheet, so without an opaque
                white backing the document's own black text lands on the dark
                theme background. Same reason HtmlViewer and DocxViewer keep a
                white page inside a themed frame. */}
            <canvas ref={canvasRef} className="shadow-md bg-white" />
          </div>
        )}
      </div>
    </div>
  )
}
