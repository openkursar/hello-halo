/**
 * KBIndicator — compact pill shown in the space header when a space has
 * connected knowledge bases. Clicking it opens the Tlon page.
 */

import { useEffect } from 'react'
import { useTranslation } from '../../i18n'
import { BookOpen } from 'lucide-react'
import { useTlonStore } from '../../stores/tlon.store'
import { useAppStore } from '../../stores/app.store'

interface KBIndicatorProps {
  spaceId: string
}

export function KBIndicator({ spaceId }: KBIndicatorProps) {
  const { t } = useTranslation()
  const kbs = useTlonStore(s => s.kbs)
  const loadKBs = useTlonStore(s => s.loadKBs)
  const setView = useAppStore(s => s.setView)

  useEffect(() => {
    if (kbs.length === 0) loadKBs()
  }, [kbs.length, loadKBs])

  const connected = kbs.filter(kb => kb.spaceIds.includes(spaceId))
  if (connected.length === 0) return null

  return (
    <button
      onClick={() => setView('tlon')}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-primary/10 text-primary text-xs hover:bg-primary/20 transition-colors"
      title={t('{{count}} knowledge base(s) connected', { count: connected.length })}
    >
      <BookOpen className="w-3.5 h-3.5" />
      <span className="hidden sm:inline tabular-nums">{connected.length}</span>
    </button>
  )
}
