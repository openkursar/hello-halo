/**
 * Placeholder viewer for .pptx tabs — no in-canvas rendering yet, so this
 * shows a friendly notice with open-externally / download escape hatches.
 */

import type { CanvasTab } from '../../../stores/canvas.store'
import { useTranslation } from '../../../i18n'
import { OfficeFallback } from './OfficeFallback'

interface PptxViewerProps {
  tab: CanvasTab
}

export default function PptxViewer({ tab }: PptxViewerProps) {
  const { t } = useTranslation()
  return (
    <OfficeFallback
      tab={tab}
      title={t('Presentation preview is not supported yet')}
      detail={t('You can open this file in an external application.')}
    />
  )
}
