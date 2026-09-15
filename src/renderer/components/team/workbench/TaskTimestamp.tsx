import { useEffect } from 'react'
import { useTranslation } from '../../../i18n'
import { taskTime } from './time'

export function TaskTimestamp({ value, recordId, className, format = 'time' }: {
  value: unknown; recordId: string; className?: string; format?: 'time' | 'date' | 'datetime'
}) {
  const { t } = useTranslation()
  const at = taskTime(value)
  useEffect(() => {
    if (at === null) console.warn('[TeamWorkbench] Invalid record timestamp', { recordId, valueType: typeof value })
  }, [at, recordId, value])
  if (at === null) return <span className={className}>{t('Time unknown')}</span>
  const timestamp = new Date(at)
  const today = timestamp.toDateString() === new Date().toDateString()
  return <time className={className} title={timestamp.toLocaleString()} dateTime={timestamp.toISOString()}>
    {timestamp.toLocaleString([], {
      ...(format !== 'time' && !today ? { month: 'short' as const, day: 'numeric' as const, ...(timestamp.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) } : {}),
      ...(format !== 'date' || today ? { hour: '2-digit' as const, minute: '2-digit' as const } : {}),
    })}
  </time>
}
