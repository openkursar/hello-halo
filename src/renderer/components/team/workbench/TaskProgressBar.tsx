import type { TaskStatus } from '../../../../shared/apps/team-types'

/** Board tasks of one conversation: done fills the track, blocked follows it in amber. */
export function TaskProgressBar({ counts, className }: { counts: Record<TaskStatus, number>; className: string }) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const share = (count: number) => `${total ? (count / total) * 100 : 0}%`
  return <span aria-hidden="true" className={`h-1 shrink-0 overflow-hidden rounded-full bg-foreground/10 ${className}`}>
    <i style={{ width: share(counts.done) }} className="h-full bg-halo-success" />
    <i style={{ width: share(counts.blocked) }} className="h-full bg-halo-warning" />
  </span>
}
