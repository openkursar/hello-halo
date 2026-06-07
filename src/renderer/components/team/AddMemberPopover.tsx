/**
 * AddMemberPopover — quick picker to add an existing digital human to a team.
 *
 * Lists automation apps in the team's owning space (or global) that are not
 * already members, and adds the chosen one via the team store.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { TeamDetail } from '../../../shared/apps/team-types'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'

interface AddMemberPopoverProps {
  teamId: string
  detail: TeamDetail
  onClose: () => void
}

export function AddMemberPopover({ teamId, detail, onClose }: AddMemberPopoverProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const addMember = useTeamStore(s => s.addMember)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  const memberIds = useMemo(() => new Set(detail.members.map(m => m.appId)), [detail.members])
  const owningSpaceId = detail.team.owningSpaceId

  const candidates = useMemo<InstalledApp[]>(
    () => apps.filter(a =>
      a.spec.type === 'automation' &&
      a.status !== 'uninstalled' &&
      !memberIds.has(a.id) &&
      (a.spaceId === owningSpaceId || a.spaceId === null)
    ),
    [apps, memberIds, owningSpaceId]
  )

  return (
    <div
      ref={ref}
      className="absolute right-0 z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
    >
      {candidates.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground/70">{t('No digital humans available to add.')}</p>
      ) : (
        candidates.map(app => (
          <button
            key={app.id}
            onClick={async () => { await addMember(teamId, { appId: app.id }); onClose() }}
            className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary/60"
          >
            {app.spec.name}
          </button>
        ))
      )}
    </div>
  )
}
