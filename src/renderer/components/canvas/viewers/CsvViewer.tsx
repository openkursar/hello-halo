/**
 * CSV Viewer - Table display for CSV files
 *
 * Features:
 * - Table view with headers
 * - Horizontal and vertical scrolling
 * - Row/column count
 * - Copy to clipboard
 * - Source view toggle
 * - Window maximize for fullscreen viewing
 */

import { useState, useRef, useEffect, useMemo } from 'react'
import { Copy, Check, ExternalLink, Table, Code2 } from 'lucide-react'
import { TableVirtuoso, type TableComponents } from 'react-virtuoso'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'
import { CodeMirrorEditor } from './CodeMirrorEditor'

interface CsvViewerProps {
  tab: CanvasTab
  onScrollChange?: (position: number) => void
}

// Simple CSV parser that handles quoted fields
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const nextChar = text[i + 1]

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote
          currentField += '"'
          i++
        } else {
          // End of quoted field
          inQuotes = false
        }
      } else {
        currentField += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        currentRow.push(currentField.trim())
        currentField = ''
      } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
        currentRow.push(currentField.trim())
        if (currentRow.length > 0 && currentRow.some(cell => cell !== '')) {
          rows.push(currentRow)
        }
        currentRow = []
        currentField = ''
        if (char === '\r') i++ // Skip \n in \r\n
      } else if (char !== '\r') {
        currentField += char
      }
    }
  }

  // Don't forget the last field/row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim())
    if (currentRow.some(cell => cell !== '')) {
      rows.push(currentRow)
    }
  }

  return rows
}

export function CsvViewer({ tab, onScrollChange }: CsvViewerProps) {
  const { t } = useTranslation()
  // Table view's scroll container is owned by TableVirtuoso itself (captured via
  // its `scrollerRef` prop below). Source view's scroll is owned by
  // CodeMirrorEditor (via its `onScroll`/`scrollPosition` props) — neither view
  // mode shares a manually-tracked scroll container anymore.
  const tableScrollerRef = useRef<HTMLElement | null>(null)
  const [copied, setCopied] = useState(false)
  const [viewMode, setViewMode] = useState<'table' | 'source'>('table')

  const content = tab.content || ''

  // Parse CSV data
  const { rows, headers, dataRows, columnCount } = useMemo(() => {
    const parsed = parseCSV(content)
    if (parsed.length === 0) {
      return { rows: [], headers: [], dataRows: [], columnCount: 0 }
    }

    const headers = parsed[0] || []
    const dataRows = parsed.slice(1)

    // Normalize column count (some rows may have different lengths)
    const maxCols = Math.max(...parsed.map(row => row.length))

    return {
      rows: parsed,
      headers,
      dataRows,
      columnCount: maxCols
    }
  }, [content])

  // Restore scroll position (table view — source view's restore is handled
  // internally by CodeMirrorEditor via its `scrollPosition` prop).
  // No `key={tab.id}` on this component means React reuses it across tab
  // switches instead of remounting, so a tab with no saved position must
  // explicitly zero the scroller — otherwise it inherits the previous tab's
  // native scrollTop, and TableVirtuoso can mount the wrong window off it.
  useEffect(() => {
    if (viewMode !== 'table' || !tableScrollerRef.current) return
    tableScrollerRef.current.scrollTop = tab.scrollPosition ?? 0
  }, [tab.id, viewMode])

  // Save scroll position (table view) — TableVirtuoso owns its scroller, so this
  // listens on the native element captured via `scrollerRef` instead of a prop.
  useEffect(() => {
    if (viewMode !== 'table' || !onScrollChange) return
    const el = tableScrollerRef.current
    if (!el) return
    const onNativeScroll = () => onScrollChange(el.scrollTop)
    el.addEventListener('scroll', onNativeScroll)
    return () => el.removeEventListener('scroll', onNativeScroll)
  }, [viewMode, onScrollChange])

  // Copy content
  const handleCopy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // Open with external application
  const handleOpenExternal = async () => {
    if (!tab.path) return
    try {
      await api.openArtifact(tab.path)
    } catch (err) {
      console.error('Failed to open with external app:', err)
    }
  }

  const canOpenExternal = !api.isRemoteMode() && tab.path

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">CSV</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{t('{{count}} rows', { count: dataRows.length })}</span>
          <span className="text-muted-foreground/50">×</span>
          <span>{t('{{count}} columns', { count: columnCount })}</span>
        </div>

        <div className="flex items-center gap-1">
          {/* View mode toggle */}
          <div className="flex items-center bg-secondary/50 rounded-md p-0.5">
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'table'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={t('Table view')}
            >
              <Table className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('source')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'source'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={t('Source view')}
            >
              <Code2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title={t('Copy')}
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {/* Open with external app */}
          {canOpenExternal && (
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

      {/* Content */}
      {viewMode === 'table' ? (
        <TableView
          headers={headers}
          dataRows={dataRows}
          columnCount={columnCount}
          scrollerRef={(el) => { tableScrollerRef.current = el as HTMLElement | null }}
        />
      ) : (
        <div className="flex-1 overflow-hidden">
          <CodeMirrorEditor
            content={content}
            readOnly
            onScroll={onScrollChange}
            scrollPosition={tab.scrollPosition}
          />
        </div>
      )}
    </div>
  )
}

// Table view component — virtualized with TableVirtuoso so only the rows in the
// viewport are ever mounted (previously every row became a <tr>, so a 5MB CSV
// meant hundreds of thousands of DOM nodes and could crash the renderer).
const csvTableComponents: TableComponents<string[]> = {
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

function TableView({
  headers,
  dataRows,
  columnCount,
  scrollerRef
}: {
  headers: string[]
  dataRows: string[][]
  columnCount: number
  scrollerRef: (el: HTMLElement | Window | null) => void
}) {
  const { t } = useTranslation()

  // table-layout:fixed can't auto-size columns from off-screen rows once
  // virtualized (the browser would need every row in the DOM to measure
  // content width), so estimate each column's width once from the header and
  // the first 50 data rows, then hold it steady — same heuristic a person
  // skimming the file would use, trading perfect content-fit for a table that
  // doesn't crash on large files.
  const columnWidths = useMemo(() => {
    const sample = dataRows.slice(0, 50)
    return Array.from({ length: columnCount }, (_, col) => {
      const headerLen = (headers[col] || `Column ${col + 1}`).length
      let maxLen = headerLen
      for (const row of sample) {
        const len = (row[col] || '').length
        if (len > maxLen) maxLen = len
      }
      return Math.min(300, Math.max(80, maxLen * 8 + 24))
    })
  }, [dataRows, headers, columnCount])

  if (headers.length === 0 && dataRows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>{t('Empty file')}</p>
      </div>
    )
  }

  return (
    <TableVirtuoso
      style={{ height: '100%' }}
      scrollerRef={scrollerRef}
      data={dataRows}
      components={csvTableComponents}
      fixedHeaderContent={() => (
        <tr className="bg-secondary">
          {/* Row number header */}
          <th
            style={{ width: 48 }}
            className="px-3 py-2 text-left text-xs font-medium text-muted-foreground border-b border-r border-border"
          >
            #
          </th>
          {/* Column headers */}
          {Array.from({ length: columnCount }, (_, i) => (
            <th
              key={i}
              style={{ width: columnWidths[i] }}
              className="px-3 py-2 text-left text-xs font-medium text-foreground border-b border-r border-border whitespace-nowrap overflow-hidden text-ellipsis"
            >
              {headers[i] || t('Column {{index}}', { index: i + 1 })}
            </th>
          ))}
        </tr>
      )}
      itemContent={(rowIndex, row) => (
        <>
          {/* Row number */}
          <td className="px-3 py-1.5 text-xs text-muted-foreground/60 border-b border-r border-border/50 bg-background/50">
            {rowIndex + 1}
          </td>
          {/* Data cells */}
          {Array.from({ length: columnCount }, (_, colIndex) => (
            <td
              key={colIndex}
              className="px-3 py-1.5 border-b border-r border-border/50 whitespace-nowrap overflow-hidden text-ellipsis"
              title={row[colIndex] || ''}
            >
              {row[colIndex] || ''}
            </td>
          ))}
        </>
      )}
    />
  )
}
