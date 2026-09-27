/**
 * Digital humans usable in a space: installed in that space, or global.
 *
 * The conversation list, the input's recipient selector and the resource rail
 * must agree on who is available — keeping the rule here stops the three from
 * drifting apart.
 */

import { useEffect, useMemo } from 'react'
import { useAppsStore } from '../stores/apps.store'
import { useTeamStore } from '../stores/team.store'
import { coordinatorIds, ephemeralMemberIds } from '../utils/people-model'
import type { InstalledApp } from '../../shared/apps/app-types'

interface Options {
  /** Keep soft-deleted apps, which surfaces still holding their conversations need. */
  includeUninstalled?: boolean
}

export function useSpaceDigitalHumans(spaceId: string | null, { includeUninstalled = false }: Options = {}): InstalledApp[] {
  const apps = useAppsStore(s => s.apps)
  const loadApps = useAppsStore(s => s.loadApps)
  const teams = useTeamStore(s => s.teams)

  // A surface can mount without the digital-humans page ever having run.
  useEffect(() => { loadApps() }, [loadApps])
  // …and without the Teams page ever having run, which is where the hidden-
  // member knowledge comes from.
  useEffect(() => { void useTeamStore.getState().loadTeams() }, [])

  return useMemo(() => {
    if (!spaceId) return []
    // Coordinators and ephemeral-collaboration members are team-internal — a
    // person never addresses them directly.
    const hidden = new Set([...ephemeralMemberIds(teams), ...coordinatorIds(teams)])
    return apps.filter(a =>
      a.spec.type === 'automation'
      && (a.spaceId === spaceId || a.spaceId === null)
      && (includeUninstalled || a.status !== 'uninstalled')
      && !hidden.has(a.id)
    )
  }, [apps, teams, spaceId, includeUninstalled])
}
