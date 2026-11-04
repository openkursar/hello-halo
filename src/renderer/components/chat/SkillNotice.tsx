import type { SkillNotice as SkillNoticeCode } from '../../../shared/types/skills'
import { useTranslation } from '../../i18n'

export function SkillNotice({ code }: { code: SkillNoticeCode }) {
  const { t } = useTranslation()
  return (
    <div role="status" className="my-2 rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground break-words">
      {code === 'catalog-unavailable'
        ? t('Skills are temporarily unavailable. You can keep chatting; start a new conversation to try skills again.')
        : code === 'skill-unsupported'
          ? t('This skill may be unavailable with this engine. Switch to Halo SDK to use it.')
          : t('Some Halo skills may be unavailable with this engine. Switch to Halo SDK to use them.')}
    </div>
  )
}
