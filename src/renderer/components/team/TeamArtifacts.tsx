/**
 * A run's shared files, and opening one with the system default application.
 *
 * Files are opened by the reference they were published under, never by the
 * path in the listing: that path is resolved against THIS machine, while a file
 * produced by a teammate's digital human sits on the teammate's machine. Main
 * decides where the bytes are and fetches a copy when they are elsewhere, so
 * nothing here needs to know which case it is holding.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useNotificationStore } from '../../stores/notification.store'
import type { TeamArtifactOpenFailure } from '../../../shared/apps/team-types'

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

interface ArtifactGroup {
  memberName?: string
  epochId?: string
  artifacts: { name: string; path: string; relativePath?: string }[]
}

export interface ArtifactEntry {
  name: string
  path: string
  /** The reference this file was published under — how it is addressed to open. */
  ref: string
  /** The run it belongs to; the other half of its address. */
  epochId: string
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
  // basename/ref → the entry it addresses, for callers holding only a ref.
  const [byRef, setByRef] = useState<Map<string, ArtifactEntry>>(new Map())
  // Same data, as an ordered de-duplicated list for callers that render
  // "everything this run produced" rather than looking up one ref.
  const [list, setList] = useState<ArtifactEntry[]>([])
  const [status, setStatus] = useState<ArtifactStatus>('loading')
  // Which run the entries on hand belong to. A refetch of the same run must not
  // blank them: the caller refetches whenever a task finishes, and links the
  // reader was about to click would go dead under the pointer.
  const loadedKey = useRef<string | null>(null)
  const key = `${teamId}\u0000${epochId ?? ''}`
  const { t } = useTranslation()

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
        const map = new Map<string, ArtifactEntry>()
        const entries: ArtifactEntry[] = []
        const seenPaths = new Set<string>()
        for (const g of groups) {
          for (const a of g.artifacts) {
            const ref = a.relativePath || a.name
            const entry: ArtifactEntry = {
              name: baseName(a.name),
              path: a.path,
              ref,
              epochId: g.epochId ?? epochId ?? '',
              memberName: g.memberName,
            }
            if (!seenPaths.has(a.path)) {
              seenPaths.add(a.path)
              entries.push(entry)
            }
            if (!map.has(entry.name)) map.set(entry.name, entry)
            if (!map.has(ref)) map.set(ref, entry)
          }
        }
        setByRef(map)
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
    (ref: string) => byRef.has(ref) || byRef.has(baseName(ref)),
    [byRef]
  )

  const describeFailure = useCallback((reason: TeamArtifactOpenFailure | undefined, owner: string | null | undefined): string => {
    const who = owner ?? t('a teammate')
    switch (reason) {
      case 'not-found':
        return t('This file is no longer where it was published from — it was moved or deleted.')
      case 'ambiguous':
        return t('More than one member published a file under this name, so there is no way to tell which one you mean.')
      case 'unreachable':
        return t('{{owner}}’s computer is offline, so this file can’t be fetched right now.', { owner: who })
      case 'unavailable':
        return t('This file is on {{owner}}’s computer and can’t be fetched right now.', { owner: who })
      case 'too-large':
        return t('This file is too large to copy here. Ask {{owner}} to share it another way.', { owner: who })
      default:
        return t('Couldn’t open this file just now.')
    }
  }, [t])

  // A toast rather than a message beside the list: files are opened from the
  // activity timeline too, where no list is on screen — and the Outputs list
  // itself starts collapsed.
  const notify = useCallback((title: string, variant: 'error' | 'default') => {
    useNotificationStore.getState().show({ id: 'team-artifact-open', title, variant, duration: 6000 })
  }, [])

  const openEntry = useCallback(async (entry: ArtifactEntry) => {
    // Remote mode has no local application to open into, and the returned path
    // would name the server's disk — download the bytes instead.
    if (api.isRemoteMode()) {
      void api.downloadArtifact(entry.path)
      return
    }
    try {
      const res = await api.teamOpenArtifact(teamId, entry.epochId, entry.ref)
      const result = res.success ? res.data : undefined
      if (!result?.ok || !result.path) {
        notify(describeFailure(result?.reason, result?.owner), 'error')
        return
      }
      if (result.revealOnly) {
        void api.showArtifactInFolder(result.path)
        notify(t('This file could run a program, so it is shown in its folder instead of being opened.'), 'default')
        return
      }
      void api.openArtifact(result.path)
    } catch (err) {
      console.warn('[TeamArtifacts] open failed', { teamId, ref: entry.ref, err })
      notify(describeFailure('error', null), 'error')
    }
  }, [teamId, describeFailure, notify, t])

  const open = useCallback((ref: string) => {
    const entry = byRef.get(ref) ?? byRef.get(baseName(ref))
    if (entry) void openEntry(entry)
  }, [byRef, openEntry])

  return { has, open, openEntry, status, list }
}
