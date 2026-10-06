/**
 * When the execution in progress started and how long it has been going, for
 * the activity thread's in-progress card: a run with no visible output is
 * otherwise indistinguishable from one that has just begun.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { formatElapsed, formatRunStart } from '../../utils/format-time'

export function RunningSince({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <p className="mt-2 text-xs text-muted-foreground tabular-nums">
      {t('Started at {{time}} · running for {{elapsed}}', {
        time: formatRunStart(startedAt, now),
        elapsed: formatElapsed(now - startedAt),
      })}
    </p>
  )
}
