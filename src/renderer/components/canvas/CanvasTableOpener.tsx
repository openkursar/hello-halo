/**
 * Lets markdown tables rendered below it (chat replies, tool results) open in
 * this page's canvas as a CSV tab — for tables too wide to read in place.
 */

import { useCallback } from 'react'
import { useCanvasStore } from '../../stores/canvas.store'
import { OpenTableContext } from '../chat/open-table-context'
import { useTranslation } from '../../i18n'

export function CanvasTableOpener({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const openContent = useCanvasStore(s => s.openContent)
  const openTable = useCallback(
    (csv: string) => openContent(csv, t('Table'), 'csv'),
    [openContent, t]
  )

  return <OpenTableContext.Provider value={openTable}>{children}</OpenTableContext.Provider>
}
