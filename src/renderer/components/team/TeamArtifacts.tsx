/**
 * Resolves a run's declared output files to openable paths, so their chips
 * (in Recent Activity / History) open with the system default app on click.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

interface ArtifactGroup {
  memberName?: string
  artifacts: { name: string; path: string; relativePath?: string }[]
}

export interface ArtifactEntry {
  name: string
  path: string
  /** Whose file this is — only rendered when another entry shares the same name. */
  memberName?: string
}

/**
 * `loading` and `failed` both mean "we do not know yet". Callers must not draw
 * them the same way as `ready`, because in `ready` a missing name means the
 * file is genuinely not there — and a reader who opens a finished run to
 * collect its output reads "not there" as "my files are gone".
 */
export type ArtifactStatus = 'loading' | 'ready' | 'failed'

export function useTeamArtifacts(
  teamId: string,
  epochId: string | null | undefined,
  refreshToken?: string | number
) {
  // basename → absolute path for every produced file in this run.
  const [pathByName, setPathByName] = useState<Map<string, string>>(new Map())
  // Same data as pathByName, kept as an ordered, de-duplicated list for callers
  // that render "everything this run produced" rather than looking up one ref.
  const [list, setList] = useState<ArtifactEntry[]>([])
  const [status, setStatus] = useState<ArtifactStatus>('loading')
  // Which run the paths on hand belong to. A refetch of the same run must not
  // blank them: the caller refetches whenever a task finishes, and links the
  // reader was about to click would go dead under the pointer.
  const loadedKey = useRef<string | null>(null)
  const key = `${teamId}\u0000${epochId ?? ''}`

  useEffect(() => {
    let cancelled = false
    if (loadedKey.current !== key) setStatus('loading')
    void (async () => {
      try {
        const res = epochId
          ? await api.teamEpochArtifacts(teamId, epochId)
          : await api.teamListArtifacts(teamId)
        if (cancelled) return
        if (!res?.success) {
          console.warn('[TeamArtifacts] lookup rejected', { teamId, epochId, error: res?.error })
          setStatus('failed')
          return
        }
        const groups = (res.data as ArtifactGroup[]) ?? []
        // Lookup keys: the stored ref exactly, plus its basename as a fallback.
        // First publisher wins — two members can publish different files under
        // one basename, and overwriting here was how a click opened the other
        // member's file.
        const map = new Map<string, string>()
        const entries: ArtifactEntry[] = []
        const seenPaths = new Set<string>()
        for (const g of groups) {
          for (const a of g.artifacts) {
            const name = baseName(a.name)
            if (!seenPaths.has(a.path)) {
              seenPaths.add(a.path)
              entries.push({ name, path: a.path, memberName: g.memberName })
            }
            if (!map.has(name)) map.set(name, a.path)
            if (a.relativePath && !map.has(a.relativePath)) map.set(a.relativePath, a.path)
          }
        }
        setPathByName(map)
        setList(entries)
        loadedKey.current = key
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        // Swallowing this used to leave an empty map, which reads on screen as
        // "this run produced nothing".
        console.warn('[TeamArtifacts] lookup failed', { teamId, epochId, err })
        setStatus('failed')
      }
    })()
    return () => { cancelled = true }
  }, [teamId, epochId, refreshToken, key])

  const has = useCallback(
    (ref: string) => pathByName.has(ref) || pathByName.has(baseName(ref)),
    [pathByName]
  )

  const openPath = useCallback((path: string) => {
    if (api.isRemoteMode()) void api.downloadArtifact(path)
    else void api.openArtifact(path)
  }, [])

  const open = useCallback((ref: string) => {
    const path = pathByName.get(ref) ?? pathByName.get(baseName(ref))
    if (path) openPath(path)
  }, [pathByName, openPath])

  return { has, open, openPath, status, list }
}
