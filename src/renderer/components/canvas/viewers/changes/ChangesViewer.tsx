/**
 * Canvas viewer of the `changes` content type: a space's Git changes, or the
 * edits one AI reply made. See this folder's modules for the parts; the
 * canvas rules they follow are in `components/canvas/DESIGN.md`.
 */

import type { TabState } from '../../../../services/canvas-lifecycle'
import { useTranslation } from '../../../../i18n'
import { GitChangesView } from './GitChangesView'
import { MessageChangesView } from './message/MessageChangesView'

export default function ChangesViewer({ tab }: { tab: TabState }) {
  const { t } = useTranslation()
  const source = tab.changes
  if (!source) {
    return <p className="p-6 text-sm text-muted-foreground">{t('These changes are no longer available.')}</p>
  }
  return source.kind === 'git'
    ? <GitChangesView tab={tab} source={source} />
    : <MessageChangesView tab={tab} source={source} />
}
