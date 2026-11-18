import type { TeamOutput } from '../../../../shared/apps/team-types'

export type OutputPeriod =
  | { kind: 'today' | 'yesterday' | 'week' | 'month' }
  | { kind: 'past'; year: number; month: number }

export interface OutputGroup {
  key: string
  period: OutputPeriod
  outputs: TeamOutput[]
}

/** Newest-first outputs bucketed by when they were made: today, yesterday, earlier this week (from Monday), earlier this month, then by month. */
export function outputGroups(outputs: readonly TeamOutput[], now = Date.now()): OutputGroup[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const week = new Date(today)
  week.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const month = new Date(today.getFullYear(), today.getMonth(), 1)

  const groups: OutputGroup[] = []
  for (const output of outputs) {
    const period: OutputPeriod = output.at >= today.getTime() ? { kind: 'today' }
      : output.at >= yesterday.getTime() ? { kind: 'yesterday' }
        : output.at >= week.getTime() ? { kind: 'week' }
          : output.at >= month.getTime() ? { kind: 'month' }
            : { kind: 'past', year: new Date(output.at).getFullYear(), month: new Date(output.at).getMonth() }
    const key = period.kind === 'past' ? `${period.year}-${period.month}` : period.kind
    const last = groups[groups.length - 1]
    if (last?.key === key) last.outputs.push(output)
    else groups.push({ key, period, outputs: [output] })
  }
  return groups
}

/** Append a page, dropping what an earlier page already held: a file declared again moves up and would otherwise show twice. */
export function mergeOutputs(current: readonly TeamOutput[], page: readonly TeamOutput[]): TeamOutput[] {
  const seen = new Set(current.map(outputKey))
  return [...current, ...page.filter(output => !seen.has(outputKey(output)))]
}

export function outputKey(output: Pick<TeamOutput, 'epochId' | 'ref'>): string {
  return `${output.epochId}\u0000${output.ref}`
}
