import type { ReactNode } from 'react'
import { LockKeyhole } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface LockedComposerProps {
  reason: string
  roomy: boolean
  onStop?: () => void
  /** Where to go instead, at the start of the action row. */
  action?: ReactNode
}

/** The composer's frame, locked: it stays in place so the user sees where they would type, with the reason written inside. */
export function LockedComposer({ reason, roomy, onStop, action }: LockedComposerProps) {
  const { t } = useTranslation()
  return <div className={roomy ? 'shrink-0 px-6 pb-[18px] pt-3' : 'shrink-0 p-3'}>
    <div aria-disabled="true" className={`${roomy ? 'mx-auto max-w-chat ' : ''}flex flex-col rounded-[18px] border border-border bg-secondary/40 px-4 pb-2 pt-3`}>
      <div className="flex min-h-[26px] items-start gap-2 text-[13px] leading-[1.5] text-muted-foreground">
        <LockKeyhole size={14} className="mt-[5px] shrink-0" aria-hidden="true" />
        <span role="status" className="min-w-0 flex-1">{reason}</span>
      </div>
      <div className="mt-1.5 flex min-h-[34px] items-center justify-end gap-1">
        {action && <div className="mr-auto min-w-0">{action}</div>}
        {onStop && <button type="button" onClick={onStop} title={t('Stop generation')} aria-label={t('Stop generation')}
          className="flex h-8 w-8 items-center justify-center rounded-sm bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20 active:bg-destructive/30">
          <span className="h-3 w-3 rounded-sm border-2 border-current" />
        </button>}
        <span aria-hidden="true" className="flex h-[34px] w-[34px] cursor-not-allowed items-center justify-center rounded-full bg-muted/50 text-muted-foreground/40">
          <svg className="h-[17px] w-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" /></svg>
        </span>
      </div>
    </div>
  </div>
}
