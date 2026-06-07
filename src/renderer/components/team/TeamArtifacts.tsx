/**
 * Resolves a run's declared output files to openable paths, so their chips
 * (in Recent Activity / History) open with the system default app on click.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

interface ArtifactGroup {
  artifacts: { name: string; path: string; relativePath?: string }[]
}

export function useTeamArtifacts(
  teamId: string,
  epochId: string | null | undefined,
  refreshToken?: string | number
) {
  // basename → absolute path for every produced file in this run.
  const [pathByName, setPathByName] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = epochId
        ? await api.teamEpochArtifacts(teamId, epochId)
        : await api.teamListArtifacts(teamId)
      if (cancelled) return
      const groups = (res?.success ? (res.data as ArtifactGroup[]) : []) ?? []
      const map = new Map<string, string>()
      for (const g of groups) {
        for (const a of g.artifacts) {
          map.set(baseName(a.name), a.path)
          if (a.relativePath) map.set(baseName(a.relativePath), a.path)
        }
      }
      setPathByName(map)
    })()
    return () => { cancelled = true }
  }, [teamId, epochId, refreshToken])

  const has = useCallback((ref: string) => pathByName.has(baseName(ref)), [pathByName])

  const open = useCallback((ref: string) => {
    const path = pathByName.get(baseName(ref))
    if (!path) return
    if (api.isRemoteMode()) void api.downloadArtifact(path)
    else void api.openArtifact(path)
  }, [pathByName])

  return { has, open }
}
