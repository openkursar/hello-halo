/**
 * Parses .xlsx/.xls bytes off the UI thread with SheetJS and returns plain
 * display data (formatted cell text + merge spans) per sheet. Large sheets are
 * truncated at fixed caps — the viewer shows a truncation notice and offers
 * opening externally.
 */

import * as XLSX from 'xlsx'

export interface XlsxMerge {
  r: number
  c: number
  rowSpan: number
  colSpan: number
}

export interface XlsxSheet {
  name: string
  /** Formatted display text, row-major, row 0 = first sheet row. */
  rows: string[][]
  merges: XlsxMerge[]
  totalRows: number
  totalCols: number
  truncated: boolean
}

export type XlsxWorkerResult =
  | { ok: true; sheets: XlsxSheet[] }
  | { ok: false; error: string }

const MAX_ROWS = 20000
const MAX_COLS = 256

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const workbook = XLSX.read(event.data, { type: 'array' })
    const sheets: XlsxSheet[] = workbook.SheetNames.map((name) => {
      const ws = workbook.Sheets[name]
      const ref = ws['!ref']
      if (!ref) {
        return { name, rows: [], merges: [], totalRows: 0, totalCols: 0, truncated: false }
      }

      const range = XLSX.utils.decode_range(ref)
      const totalRows = range.e.r - range.s.r + 1
      const totalCols = range.e.c - range.s.c + 1
      const rowCount = Math.min(totalRows, MAX_ROWS)
      const colCount = Math.min(totalCols, MAX_COLS)
      const limited = {
        s: range.s,
        e: { r: range.s.r + rowCount - 1, c: range.s.c + colCount - 1 },
      }

      // raw:false yields the number-formatted display text (dates, currency, %)
      const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: true,
        range: XLSX.utils.encode_range(limited),
      })

      const merges: XlsxMerge[] = (ws['!merges'] || [])
        .map((m) => ({
          r: m.s.r - range.s.r,
          c: m.s.c - range.s.c,
          rowSpan: m.e.r - m.s.r + 1,
          colSpan: m.e.c - m.s.c + 1,
        }))
        .filter((m) => m.r >= 0 && m.c >= 0 && m.r < rowCount && m.c < colCount)

      return {
        name,
        rows,
        merges,
        totalRows,
        totalCols,
        truncated: rowCount < totalRows || colCount < totalCols,
      }
    })

    const result: XlsxWorkerResult = { ok: true, sheets }
    self.postMessage(result)
  } catch (error) {
    const result: XlsxWorkerResult = { ok: false, error: (error as Error).message }
    self.postMessage(result)
  }
}
