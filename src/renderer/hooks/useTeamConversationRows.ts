import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Team, TeamListItem, TeamNativeTaskPage, TeamRosterFace, TeamUpdatedEvent } from '../../shared/apps/team-types'
import { teamTaskKey, useTeamChatPinsStore } from '../stores/team-chat-pins.store'
import { useTeamChatHiddenStore, type HiddenTeamChat } from '../stores/team-chat-hidden.store'

export type NativeTeamTask = TeamNativeTaskPage['items'][number]
type TeamSummary = Pick<Team, 'id' | 'name'> & Partial<Pick<TeamListItem, 'roster'>>

/**
 * Faces shown for a team. `overflow` counts the members not shown as a plain
 * face: with a full set of four faces the last one is veiled and counted in it.
 */
export interface TeamAvatarFaces { names: string[]; overflow: number }
export type TeamListRow =
  | { type: 'team-header'; key: string; teamId: string; name: string; collapsed: boolean; avatar: TeamAvatarFaces }
  | { type: 'team-item'; key: string; task: NativeTeamTask; standalone: boolean; starred: boolean; avatar: TeamAvatarFaces }
  | { type: 'team-retry'; key: string }
  /** Tasks of this team the person removed from the list, with the way back. */
  | { type: 'team-hidden'; key: string; teamId: string; count: number }

const EMPTY_PINS: string[] = []
const EMPTY_HIDDEN: Record<string, HiddenTeamChat> = {}
const EMPTY_FACES: TeamAvatarFaces = { names: [], overflow: 0 }
const PAGE_SIZE = 50
const AVATAR_SLOTS = 4

/**
 * Up to four slots, lead first: every member when the team fits, otherwise four
 * faces with the last one veiled by `+n` (n = total - 3, the veiled member included).
 */
export function teamAvatarFaces(roster: readonly TeamRosterFace[]): TeamAvatarFaces {
  const faces = [...roster].sort((a, b) => Number(b.isLead) - Number(a.isLead))
  const names = faces.slice(0, AVATAR_SLOTS).map(member => member.memberName)
  return { names, overflow: faces.length > AVATAR_SLOTS ? faces.length - (AVATAR_SLOTS - 1) : 0 }
}

export function buildTeamRows(tasks: NativeTeamTask[], teams: TeamSummary[], pins: string[], isOpen: (id: string) => boolean, hidden: Record<string, HiddenTeamChat> = EMPTY_HIDDEN) {
  const pinned: TeamListRow[] = []
  const rows: TeamListRow[] = []
  const groups = new Map(teams.map(team => [team.id, { name: team.name, avatar: teamAvatarFaces(team.roster ?? []), tasks: [] as NativeTeamTask[], hidden: 0 }]))
  for (const task of tasks) {
    const group = groups.get(task.teamId) ?? { name: task.teamName, avatar: EMPTY_FACES, tasks: [], hidden: 0 }
    if (hidden[teamTaskKey(task.teamId, task.epochId)]) group.hidden++
    else group.tasks.push(task)
    groups.set(task.teamId, group)
  }
  for (const [teamId, group] of groups) {
    const collapsed = !isOpen(teamId)
    rows.push({ type: 'team-header', key: `team:${teamId}`, teamId, name: group.name, collapsed, avatar: group.avatar })
    for (const task of group.tasks) {
      const key = teamTaskKey(teamId, task.epochId)
      const starred = pins.includes(key)
      const row: TeamListRow = { type: 'team-item', key, task, standalone: starred, starred, avatar: group.avatar }
      if (starred) pinned.push(row)
      else if (!collapsed) rows.push(row)
    }
    if (!collapsed && group.hidden > 0) rows.push({ type: 'team-hidden', key: `team-hidden:${teamId}`, teamId, count: group.hidden })
  }
  return { rows, pinned }
}

/** Metadata only; one mounted space, bounded pages, no per-team history reads. */
export function useTeamConversationRows(spaceId: string | null | undefined, enabled = true) {
  const [state, setState] = useState<{ spaceId: string; tasks: NativeTeamTask[]; teams: TeamSummary[]; cursor: string | null; loading: boolean; error: boolean }>({ spaceId: '', tasks: [], teams: [], cursor: null, loading: false, error: false })
  const commands = useRef({ more: () => {}, refresh: () => {} })
  const pins = useTeamChatPinsStore(s => s.pinned[spaceId ?? '']) ?? EMPTY_PINS
  const hidden = useTeamChatHiddenStore(s => s.hidden[spaceId ?? '']) ?? EMPTY_HIDDEN
  useEffect(() => {
    if (!spaceId || !enabled) return
    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let summaryTimer: ReturnType<typeof setTimeout> | undefined
    let trailing = false
    let taskError = false
    let summaryError = false
    let pinnedTasks: NativeTeamTask[] = []
    let tasks: NativeTeamTask[] = []
    let teams: TeamSummary[] = []
    let cursor: string | null = null
    const publish = (loading: boolean) => {
      if (disposed) return
      const combined = new Map([...pinnedTasks, ...tasks].map(task => [teamTaskKey(task.teamId, task.epochId), task]))
      setState({ spaceId, tasks: [...combined.values()], teams, cursor, loading, error: taskError || summaryError })
    }
    const load = async (more = false) => {
      if (disposed) return
      if (inFlight) { if (!more) trailing = true; return }
      inFlight = true
      publish(true)
      try {
        const keys = useTeamChatPinsStore.getState().pinned[spaceId] ?? []
        const epochIds = keys.map(key => key.slice(key.lastIndexOf(':') + 1))
        // A refresh re-reads as far as the person has scrolled, so the list
        // neither shrinks back to the first page nor loses its place.
        const loaded = more ? 0 : tasks.length
        const items: NativeTeamTask[] = []
        let next: string | null = more ? cursor : null
        do {
          const page = await api.teamListNativeTasks({ spaceId, limit: PAGE_SIZE, scope: 'mine', ...(next ? { cursor: next } : {}) })
          if (!page.success || !page.data) throw new Error(page.error || 'Team task list unavailable')
          if (disposed) return
          items.push(...page.data.items)
          next = page.data.nextCursor
        } while (!more && next && items.length < loaded)
        if (!more) {
          const resolved: NativeTeamTask[] = []
          for (let offset = 0; offset < epochIds.length; offset += 100) {
            const pinned = await api.teamListNativeTasks({ spaceId, epochIds: epochIds.slice(offset, offset + 100), limit: 100 })
            if (!pinned.success || !pinned.data) throw new Error(pinned.error || 'Pinned team tasks unavailable')
            if (disposed) return
            resolved.push(...pinned.data.items)
          }
          pinnedTasks = resolved
        }
        const merged = new Map((more ? tasks : []).map(task => [teamTaskKey(task.teamId, task.epochId), task]))
        for (const task of items) merged.set(teamTaskKey(task.teamId, task.epochId), task)
        tasks = [...merged.values()]
        cursor = next
        taskError = false
        publish(false)
      } catch (error) {
        console.error('[TeamConversationList] Task page failed', { spaceId, more }, error)
        taskError = true
        publish(false)
      } finally {
        inFlight = false
        if (trailing && !disposed) { trailing = false; schedule() }
      }
    }
    const schedule = () => {
      if (timer !== undefined || disposed) return
      timer = setTimeout(() => { timer = undefined; void load() }, 250)
    }
    const loadTeams = async () => {
      try {
        const result = await api.teamList(spaceId)
        if (!result.success || !result.data) throw new Error(result.error || 'Team list unavailable')
        if (disposed) return
        teams = (result.data as TeamListItem[]).filter(team => !team.ephemeral)
        summaryError = false
      } catch (error) {
        console.error('[TeamConversationList] Team summaries failed', { spaceId }, error)
        summaryError = true
      }
      publish(inFlight)
    }
    commands.current = { more: () => { if (cursor) void load(true) }, refresh: () => { if (summaryError) void loadTeams(); schedule() } }
    publish(true)
    void loadTeams()
    void load()
    const off = api.onTeamUpdated(data => {
      const event = data as TeamUpdatedEvent
      if (event.team && event.team.owningSpaceId !== spaceId && !teams.some(team => team.id === event.teamId) && !tasks.some(task => task.teamId === event.teamId)) return
      if (event.removed) {
        teams = teams.filter(team => team.id !== event.teamId)
        tasks = tasks.filter(task => task.teamId !== event.teamId)
        pinnedTasks = pinnedTasks.filter(task => task.teamId !== event.teamId)
        publish(inFlight)
      } else if (event.team && !event.team.ephemeral) {
        const existing = teams.find(team => team.id === event.teamId)
        teams = [...teams.filter(team => team.id !== event.teamId), { ...existing, ...event.team }]
        publish(inFlight)
      }
      if (!event.removed && (!event.changed || event.changed.includes('members')) && summaryTimer === undefined) {
        summaryTimer = setTimeout(() => { summaryTimer = undefined; void loadTeams() }, 250)
      }
      // A work pulse carries who is being served; the rows take it in place.
      // A pulse without that list, or any other change, re-reads the page.
      if (event.changed?.includes('work') && event.changed.every(change => change === 'work' || change === 'status') && event.activeEpochIds && !event.removed) {
        const active = new Set(event.activeEpochIds)
        const mark = (task: NativeTeamTask) => task.teamId !== event.teamId || task.active === active.has(task.epochId) ? task : { ...task, active: active.has(task.epochId) }
        const nextTasks = tasks.map(mark)
        const nextPinned = pinnedTasks.map(mark)
        if (nextTasks.some((task, index) => task !== tasks[index]) || nextPinned.some((task, index) => task !== pinnedTasks[index])) {
          tasks = nextTasks
          pinnedTasks = nextPinned
          publish(inFlight)
        }
        return
      }
      if (!event.changed || event.changed.some(change => change === 'conversations' || change === 'epochs' || change === 'status' || change === 'work')) schedule()
    })
    return () => { disposed = true; clearTimeout(timer); clearTimeout(summaryTimer); off(); commands.current = { more: () => {}, refresh: () => {} } }
  }, [spaceId, enabled])
  const visible = state.spaceId === spaceId && enabled ? state : { tasks: [], teams: [], cursor: null, loading: false, error: false }
  const reconcileHidden = useTeamChatHiddenStore(s => s.reconcile)
  useEffect(() => {
    if (spaceId && visible.tasks.length) reconcileHidden(spaceId, new Map(visible.tasks.map(task => [teamTaskKey(task.teamId, task.epochId), task.waitingForMe === true])))
  }, [spaceId, visible.tasks, reconcileHidden])
  return useMemo(() => ({ ...visible, pins, hidden, loadMore: () => commands.current.more(), refresh: () => commands.current.refresh() }), [visible, pins, hidden])
}
