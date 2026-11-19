/**
 * The marks of the AI's work on its canvas tabs: a dot on the tab's icon, and
 * one line at the top of the tab's content. Both say whether the AI is
 * operating it right now; the dot pulses only then (not with reduced motion).
 * The line is always there on an AI tab, so the content never shifts, and it
 * has no buttons: opening is clicking the tab, stopping is closing it.
 */

import type { TabState } from '../../services/canvas-lifecycle'
import { useAIWorkOperating, useAIWorkOwnerLabel } from '../../hooks/useAIWork'
import { useTranslation } from '../../i18n'

type WorkTab = Pick<TabState, 'type' | 'terminalSessionId' | 'browserViewId'>

function dotClass(operating: boolean): string {
  return operating ? 'bg-primary motion-safe:animate-pulse' : 'bg-muted-foreground/60'
}

/** On the tab's icon, at its top-right corner (its cut-out follows the tab's background, canvas-tabs.css). */
export function AIWorkDot({ tab }: { tab: WorkTab }) {
  const operating = useAIWorkOperating(tab)
  return (
    <span
      aria-hidden="true"
      data-ai-operating={operating ? 'true' : 'false'}
      className={`canvas-tab-ai-dot absolute -right-0.5 -top-0.5 h-[7px] w-[7px] rounded-full ${dotClass(operating)}`}
    />
  )
}

/** One fixed line above the tab's content. */
export function AIWorkStatusLine({ tab }: { tab: WorkTab }) {
  const { t } = useTranslation()
  const operating = useAIWorkOperating(tab)
  const owner = useAIWorkOwnerLabel(tab)
  return (
    <div
      data-testid="ai-work-status"
      className="flex h-7 shrink-0 items-center gap-2 border-b border-border-soft bg-card px-3 text-xs text-muted-foreground"
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(operating)}`} />
      <span className={`shrink-0 ${operating ? 'text-foreground' : ''}`}>
        {operating ? t('AI is operating') : t('AI is idle')}
      </span>
      {owner && <span className="min-w-0 truncate">· {owner}</span>}
    </div>
  )
}
