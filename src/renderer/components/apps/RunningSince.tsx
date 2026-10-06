/**
 * When the execution in progress started and how long it has been going, for
 * the activity thread's in-progress card: a run with no visible output is
 * otherwise indistinguishable from one that has just begun.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { formatElapsed } from '../../utils/format-time'

function formatStart(startedAt: number, now: number): string {
  const start = new Date(startedAt)
  return start.toDateString() === new Date(now).toDateString()
    ? start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : start.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

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
        time: formatStart(startedAt, now),
        elapsed: formatElapsed(now - startedAt),
      })}
    </p>
  )
}
