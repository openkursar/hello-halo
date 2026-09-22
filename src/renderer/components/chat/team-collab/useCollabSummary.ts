/**
 * The team collaboration bound to one space conversation, kept live.
 *
 * One shared hook so every surface (the in-chat panel, anything later) reads
 * the same projection: fetched from the main side and refreshed on the team
 * event stream, which fires for status flips, board writes and messages.
 *
 * Those events are high-frequency — a working team writes the board and passes
 * messages continuously — while the projection itself changes rarely (a member
 * flips status, a task title changes). So refreshes are coalesced to one in
 * flight plus one trailing, events for other teams are ignored once this
 * conversation's team is known, and an unchanged projection keeps its previous
 * object so subscribers do not re-render.
 */

import { useEffect, useRef, useState } from 'react'
import { api } from '../../../api'
import type { CollabSummary, CollabMemberSummary } from '../../../../shared/apps/team-types'

/** Minimum gap between two fetches while events keep arriving. */
const REFRESH_COALESCE_MS = 200

function sameMember(a: CollabMemberSummary, b: CollabMemberSummary): boolean {
  return a.appId === b.appId
    && a.memberName === b.memberName
    && a.role === b.role
    && a.status === b.status
    && a.currentTaskTitle === b.currentTaskTitle
}

function sameCollab(a: CollabSummary | null, b: CollabSummary | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.teamId === b.teamId
    && a.name === b.name
    && a.goal === b.goal
    && a.epochId === b.epochId
    && a.active === b.active
    && a.saved === b.saved
    && a.members.length === b.members.length
    && a.members.every((m, i) => sameMember(m, b.members[i]))
}

export function useCollabSummary(conversationId: string | null | undefined): CollabSummary | null {
  const [collab, setCollab] = useState<CollabSummary | null>(null)
  // Mirrors `collab` for the event handlers, which must not re-subscribe on it.
  const collabRef = useRef<CollabSummary | null>(null)

  useEffect(() => {
    collabRef.current = null
    setCollab(null)
    if (!conversationId) return

    let disposed = false
    let inFlight = false
    let trailing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastFetchAt = 0

    const fetch = async () => {
      inFlight = true
      try {
        const res = await api.teamCollabForConversation(conversationId)
        if (disposed) return
        const next = res.success ? ((res.data as CollabSummary | null) ?? null) : null
        if (!sameCollab(collabRef.current, next)) {
          collabRef.current = next
          setCollab(next)
        }
      } catch {
        if (disposed) return
        if (collabRef.current !== null) {
          collabRef.current = null
          setCollab(null)
        }
      } finally {
        inFlight = false
        lastFetchAt = Date.now()
        if (trailing && !disposed) {
          trailing = false
          schedule()
        }
      }
    }

    const schedule = () => {
      if (disposed || timer) return
      if (inFlight) { trailing = true; return }
      const wait = Math.max(0, REFRESH_COALESCE_MS - (Date.now() - lastFetchAt))
      timer = setTimeout(() => {
        timer = undefined
        void fetch()
      }, wait)
    }

    // A team event for some other team cannot change this conversation's
    // projection. Until the first fetch tells us which team this is, every
    // event has to be taken (that is how a newly created collaboration is
    // discovered) — but that window only exists while no team is bound.
    const onTeamEvent = (data: unknown) => {
      const bound = collabRef.current
      if (bound) {
        const teamId = (data as { teamId?: string } | null)?.teamId
        if (teamId && teamId !== bound.teamId) return
      }
      schedule()
    }

    void fetch()
    const offUpdated = api.onTeamUpdated(onTeamEvent)
    const offBlackboard = api.onTeamBlackboard(onTeamEvent)
    const offMessage = api.onTeamMessage(onTeamEvent)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      offUpdated()
      offBlackboard()
      offMessage()
    }
  }, [conversationId])

  return collab
}
