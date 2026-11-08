import { useTranslation } from '../../i18n'

/** Stored transcripts may carry notices of earlier builds; only the one still produced is shown. */
export function SkillNotice({ code }: { code: string }) {
  const { t } = useTranslation()
  if (code !== 'catalog-unavailable') return null
  return (
    <div role="status" className="my-2 rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground break-words">
      {t('Skills are temporarily unavailable. You can keep chatting; start a new conversation to try skills again.')}
    </div>
  )
}
