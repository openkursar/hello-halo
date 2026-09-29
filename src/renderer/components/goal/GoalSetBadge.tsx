import { Target } from 'lucide-react'
import { useTranslation } from '../../i18n'

/** Marks a user message that set the conversation goal, so the history explains itself. */
export function GoalSetBadge() {
  const { t } = useTranslation()
  return (
    <span className="flex w-fit items-center gap-1 h-5 px-1.5 mb-1.5 rounded-md bg-primary/[0.12] text-accent-on-dark text-[11px] font-medium">
      <Target size={12} aria-hidden />
      {t('Goal set')}
    </span>
  )
}
