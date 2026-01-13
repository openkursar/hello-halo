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

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Copy, Check, ExternalLink, Table, Code2 } from 'lucide-react'
import { api } from '../../../api'
import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'

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
  const containerRef = useRef<HTMLDivElement>(null)
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

  // Restore scroll position
  useEffect(() => {
    if (containerRef.current && tab.scrollPosition !== undefined) {
      containerRef.current.scrollTop = tab.scrollPosition
    }
  }, [tab.id])

  // Save scroll position
  const handleScroll = useCallback(() => {
    if (containerRef.current && onScrollChange) {
      onScrollChange(containerRef.current.scrollTop)
    }
  }, [onScrollChange])

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

  // Count lines for source view
  const lines = content.split('\n')
  const lineCount = lines.length
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
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto"
      >
        {viewMode === 'table' ? (
          <TableView headers={headers} dataRows={dataRows} columnCount={columnCount} />
        ) : (
          <SourceView content={content} lineCount={lineCount} />
        )}
      </div>
    </div>
  )
}

// Table view component
function TableView({
  headers,
  dataRows,
  columnCount
}: {
  headers: string[]
  dataRows: string[][]
  columnCount: number
}) {
  const { t } = useTranslation()
  if (headers.length === 0 && dataRows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>{t('Empty file')}</p>
      </div>
    )
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead className="sticky top-0 z-10">
        <tr className="bg-secondary/80 backdrop-blur-sm">
          {/* Row number header */}
          <th className="w-12 px-3 py-2 text-left text-xs font-medium text-muted-foreground border-b border-r border-border">
            #
          </th>
          {/* Column headers */}
          {Array.from({ length: columnCount }, (_, i) => (
            <th
              key={i}
              className="px-3 py-2 text-left text-xs font-medium text-foreground border-b border-r border-border whitespace-nowrap"
            >
              {headers[i] || t('Column {{index}}', { index: i + 1 })}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dataRows.map((row, rowIndex) => (
          <tr
            key={rowIndex}
            className="hover:bg-secondary/30 transition-colors"
          >
            {/* Row number */}
            <td className="w-12 px-3 py-1.5 text-xs text-muted-foreground/60 border-b border-r border-border/50 bg-background/50">
              {rowIndex + 1}
            </td>
            {/* Data cells */}
            {Array.from({ length: columnCount }, (_, colIndex) => (
              <td
                key={colIndex}
                className="px-3 py-1.5 border-b border-r border-border/50 whitespace-nowrap max-w-[300px] overflow-hidden text-ellipsis"
                title={row[colIndex] || ''}
              >
                {row[colIndex] || ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// Source view component
function SourceView({ content, lineCount }: { content: string; lineCount: number }) {
  const lines = content.split('\n')

  return (
    <div className="flex min-h-full font-mono text-sm">
      {/* Line numbers */}
      <div className="sticky left-0 flex-shrink-0 select-none bg-background/80 backdrop-blur-sm border-r border-border/50 text-right text-muted-foreground/40 text-xs pr-3 pl-4 py-4">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i + 1} className="leading-6">
            {i + 1}
          </div>
        ))}
      </div>

      {/* Content */}
      <pre className="flex-1 p-4 overflow-x-auto">
        <code className="text-foreground">
          {lines.map((line, i) => (
            <div key={i} className="leading-6">
              {line || ' '}
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}
