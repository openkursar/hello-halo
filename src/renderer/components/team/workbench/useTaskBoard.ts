import { useEffect, useMemo, useState } from 'react'
import type { BlackboardFinding, BlackboardTask, EpochBoard, TeamActivity, TeamDetail } from '../../../../shared/apps/team-types'
import { useTeamStore } from '../../../stores/team.store'

const EMPTY_ACTIVITIES: TeamActivity[] = []

type ObservedBoard = { scope: string; board: EpochBoard | null; activities: TeamActivity[]; tasks: BlackboardTask[]; findings: BlackboardFinding[] }
function mergeRows<T extends { id: string; updatedAt?: number; body?: string | null }>(previous: T[], incoming: T[]): T[] {
  if (!incoming.length) return previous
  const rows = new Map(previous.map(row => [row.id, row]))
  let changed = false
  for (const row of incoming) {
    const old = rows.get(row.id)
    if (old?.updatedAt !== undefined && row.updatedAt !== undefined && old.updatedAt > row.updatedAt) continue
    if (old === row) continue
    changed = true
    rows.set(row.id, old?.body && row.body === null ? { ...row, body: old.body } : row)
  }
  return changed ? [...rows.values()] : previous
}

export function useTaskBoard(detail: TeamDetail, epochId: string | null) {
  const scope = `${detail.team.id}:${epochId}`
  const [saved, setSaved] = useState<ObservedBoard | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const loadBoard = useTeamStore(s => s.loadEpochBoard)
  const buffered = detail.activities ?? EMPTY_ACTIVITIES
  const current = saved?.scope === scope ? saved : null
  const live = useMemo(() => ({ activities: buffered.filter(row => row.epochId === epochId), tasks: detail.tasks.filter(row => row.epochId === epochId), findings: detail.findings.filter(row => row.epochId === epochId) }), [buffered, detail.tasks, detail.findings, epochId])
  const known = useMemo(() => new Set(current?.activities.map(row => row.id)), [current?.activities])
  const coverageLost = !!current?.board && buffered.length >= 500 && live.activities.length > 0 && !live.activities.some(row => known.has(row.id))
  useEffect(() => { if (coverageLost) setRevision(value => value + 1) }, [coverageLost])
  useEffect(() => {
    if (!epochId) return
    setSaved(previous => {
      const retained = previous?.scope === scope ? previous : null
      const activities = mergeRows(retained?.activities ?? [], live.activities)
      const tasks = mergeRows(retained?.tasks ?? [], live.tasks)
      const findings = mergeRows(retained?.findings ?? [], live.findings)
      if (retained && activities === retained.activities && tasks === retained.tasks && findings === retained.findings) return retained
      return { scope, board: retained?.board ?? null, activities, tasks, findings }
    })
  }, [scope, epochId, live])
  useEffect(() => {
    let cancelled = false
    if (!epochId) return
    void loadBoard(detail.team.id, epochId).then(board => {
      if (cancelled) return
      setFailure(board ? null : scope)
      if (board) setSaved(previous => {
        const retained = previous?.scope === scope ? previous : null
        return { scope, board, activities: mergeRows(board.activities ?? [], retained?.activities ?? []), tasks: mergeRows(board.tasks, retained?.tasks ?? []), findings: mergeRows(board.findings, retained?.findings ?? []) }
      })
    })
    return () => { cancelled = true }
  }, [detail.team.id, scope, epochId, loadBoard, revision])
  const board = useMemo(() => current?.board ? { ...current.board, tasks: current.tasks, findings: current.findings, activities: current.activities } : null, [current])
  return { board, activities: current?.activities ?? [], failed: !!epochId && failure === scope, retry: () => setRevision(value => value + 1) }
}

export type TaskBoardState = ReturnType<typeof useTaskBoard>
