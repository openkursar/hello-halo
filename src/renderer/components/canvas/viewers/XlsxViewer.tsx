/**
 * Spreadsheet viewer for .xlsx/.xls tabs. Parsing happens in a Web Worker
 * (xlsx.worker.ts) so large workbooks never block the UI; rendering uses
 * TableVirtuoso like CsvViewer so only visible rows mount. Spreadsheet-style
 * A/B/C column letters form the sticky header; merged cells render via
 * colSpan on the anchor cell (vertically-covered cells render empty, since
 * rowSpan cannot cross virtualized row boundaries).
 */

import { useState, useRef, useEffect, useMemo } from 'react'
import { ExternalLink } from 'lucide-react'
import { TableVirtuoso, type TableComponents } from 'react-virtuoso'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'
import { OfficeFallback } from './OfficeFallback'
import type { XlsxSheet, XlsxWorkerResult } from './xlsx.worker'

interface XlsxViewerProps {
  tab: CanvasTab
  onScrollChange?: (position: number) => void
}

/** 0 -> A, 25 -> Z, 26 -> AA ... */
function columnLetter(index: number): string {
  let label = ''
  let n = index
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  }
  return label
}

const tableComponents: TableComponents<string[]> = {
  Table: ({ style, children }) => (
    <table
      style={{ ...style, tableLayout: 'fixed' }}
      className="w-full border-collapse text-sm"
    >
      {children}
    </table>
  ),
  TableRow: ({ item: _item, ...props }) => (
    <tr {...props} className="hover:bg-secondary/30 transition-colors" />
  )
}

export default function XlsxViewer({ tab, onScrollChange }: XlsxViewerProps) {
  const { t } = useTranslation()
  const bytes = tab.bytes
  const workerRef = useRef<Worker | null>(null)
  const [sheets, setSheets] = useState<XlsxSheet[] | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const scrollerRef = useRef<HTMLElement | null>(null)

  // Parse in the worker whenever the bytes change (initial load + refreshTab
  // after the file is rewritten on disk).
  useEffect(() => {
    if (!bytes) return
    setSheets(null)
    setParseError(null)

    const worker = new Worker(new URL('./xlsx.worker.ts', import.meta.url), {
      type: 'module'
    })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<XlsxWorkerResult>) => {
      if (event.data.ok) {
        const parsed = event.data.sheets
        setSheets(parsed)
        setActiveIdx((idx) => Math.min(idx, Math.max(0, parsed.length - 1)))
      } else {
        console.error('[XlsxViewer] Worker parse failed:', event.data.error)
        setParseError(event.data.error)
      }
    }
    worker.onerror = (event) => {
      console.error('[XlsxViewer] Worker error:', event.message)
      setParseError(event.message || 'Worker error')
    }
    // Transfer detaches the buffer, so send a copy — the tab keeps its own
    const buffer = bytes.slice().buffer
    worker.postMessage(buffer, [buffer])

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [bytes])

  const sheet = sheets?.[activeIdx] ?? null

  // Merge lookup maps for the active sheet: anchors carry colSpan, cells to the
  // right of an anchor (same row) are skipped, cells below an anchor render
  // empty to keep the grid aligned.
  const { anchorSpans, skipCells } = useMemo(() => {
    const anchorSpans = new Map<string, number>()
    const skipCells = new Set<string>()
    if (sheet) {
      for (const m of sheet.merges) {
        anchorSpans.set(`${m.r}:${m.c}`, m.colSpan)
        for (let c = m.c + 1; c < m.c + m.colSpan; c++) {
          skipCells.add(`${m.r}:${c}`)
        }
      }
    }
    return { anchorSpans, skipCells }
  }, [sheet])

  const colCount = sheet ? Math.min(sheet.totalCols, sheet.rows.reduce((max, r) => Math.max(max, r.length), 0) || sheet.totalCols) : 0

  // Same width heuristic as CsvViewer: sample the first 50 rows, hold steady.
  const columnWidths = useMemo(() => {
    if (!sheet) return []
    const sample = sheet.rows.slice(0, 50)
    return Array.from({ length: colCount }, (_, col) => {
      let maxLen = 1
      for (const row of sample) {
        const len = (row[col] || '').length
        if (len > maxLen) maxLen = len
      }
      return Math.min(300, Math.max(80, maxLen * 8 + 24))
    })
  }, [sheet, colCount])

  // Restore / save scroll position (mirrors CsvViewer's TableVirtuoso wiring)
  useEffect(() => {
    if (!scrollerRef.current) return
    scrollerRef.current.scrollTop = tab.scrollPosition ?? 0
  }, [tab.id, activeIdx, sheet])

  useEffect(() => {
    if (!onScrollChange) return
    const el = scrollerRef.current
    if (!el) return
    const onNativeScroll = () => onScrollChange(el.scrollTop)
    el.addEventListener('scroll', onNativeScroll)
    return () => el.removeEventListener('scroll', onNativeScroll)
  }, [onScrollChange, sheet])

  const handleOpenExternal = async () => {
    if (!tab.path) return
    try {
      await api.openArtifact(tab.path)
    } catch (err) {
      console.error('[XlsxViewer] Failed to open with external app:', err)
    }
  }

  if (tab.error || (!bytes && !tab.isLoading)) {
    return (
      <OfficeFallback
        tab={tab}
        title={t('Unable to preview this spreadsheet')}
        detail={tab.error || t('The file could not be read.')}
      />
    )
  }

  if (parseError) {
    return (
      <OfficeFallback
        tab={tab}
        title={t('Unable to preview this spreadsheet')}
        detail={t('The file may be corrupt or in an unsupported format.')}
      />
    )
  }

  if (!sheets) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (sheets.length === 0 || !sheet) {
    return (
      <OfficeFallback
        tab={tab}
        title={t('This spreadsheet is empty')}
      />
    )
  }

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
          <span className="font-mono shrink-0">XLSX</span>
          <span className="text-muted-foreground/50 shrink-0">·</span>
          <span className="shrink-0">{t('{{count}} rows', { count: sheet.totalRows })}</span>
          <span className="text-muted-foreground/50 shrink-0">×</span>
          <span className="shrink-0">{t('{{count}} columns', { count: sheet.totalCols })}</span>
          {sheet.truncated && (
            <span className="text-amber-500 truncate">
              {t('Large sheet — showing a partial view')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {!api.isRemoteMode() && tab.path && (
            <button
              onClick={handleOpenExternal}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Open in external application')}
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0">
        {sheet.rows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>{t('Empty sheet')}</p>
          </div>
        ) : (
          <TableVirtuoso
            key={`${tab.id}:${activeIdx}`}
            style={{ height: '100%' }}
            scrollerRef={(el) => { scrollerRef.current = el as HTMLElement | null }}
            data={sheet.rows}
            components={tableComponents}
            fixedHeaderContent={() => (
              <tr className="bg-secondary">
                <th
                  style={{ width: 48 }}
                  className="px-3 py-2 text-left text-xs font-medium text-muted-foreground border-b border-r border-border"
                >
                  #
                </th>
                {Array.from({ length: colCount }, (_, i) => (
                  <th
                    key={i}
                    style={{ width: columnWidths[i] }}
                    className="px-3 py-2 text-left text-xs font-medium text-foreground border-b border-r border-border whitespace-nowrap overflow-hidden text-ellipsis"
                  >
                    {columnLetter(i)}
                  </th>
                ))}
              </tr>
            )}
            itemContent={(rowIndex, row) => (
              <>
                <td className="px-3 py-1.5 text-xs text-muted-foreground/60 border-b border-r border-border/50 bg-background/50">
                  {rowIndex + 1}
                </td>
                {Array.from({ length: colCount }, (_, colIndex) => {
                  if (skipCells.has(`${rowIndex}:${colIndex}`)) return null
                  const colSpan = anchorSpans.get(`${rowIndex}:${colIndex}`)
                  return (
                    <td
                      key={colIndex}
                      colSpan={colSpan}
                      className="px-3 py-1.5 border-b border-r border-border/50 whitespace-nowrap overflow-hidden text-ellipsis"
                      title={row[colIndex] || ''}
                    >
                      {row[colIndex] || ''}
                    </td>
                  )
                })}
              </>
            )}
          />
        )}
      </div>

      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border bg-card/50 overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActiveIdx(i)}
              className={`px-2.5 py-1 rounded text-xs whitespace-nowrap transition-colors ${
                i === activeIdx
                  ? 'bg-background text-foreground shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
