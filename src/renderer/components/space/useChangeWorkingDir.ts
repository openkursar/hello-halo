/**
 * Pick a folder and point a workspace at it — from the workspace's settings,
 * or from a chat that could not start because its folder is gone. The folder
 * picker exists only in the desktop app; a remote page cannot change it.
 */

import { useCallback, useState } from 'react'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'

export type WorkingDirChange =
  | { state: 'idle' }
  | { state: 'changing' }
  | { state: 'changed'; workingDir: string }
  | { state: 'failed'; error: string }

export function useChangeWorkingDir(spaceId: string): {
  change: () => Promise<void>
  status: WorkingDirChange
  /** False on a remote page, which has no folder picker. */
  available: boolean
} {
  const setSpaceWorkingDir = useSpaceStore(state => state.setSpaceWorkingDir)
  const [status, setStatus] = useState<WorkingDirChange>({ state: 'idle' })
  const available = !api.isRemoteMode()

  const change = useCallback(async () => {
    if (!available) return
    const picked = await api.selectFolder()
    if (!picked.success || typeof picked.data !== 'string' || !picked.data) return
    setStatus({ state: 'changing' })
    const error = await setSpaceWorkingDir(spaceId, picked.data)
    setStatus(error ? { state: 'failed', error } : { state: 'changed', workingDir: picked.data })
  }, [available, setSpaceWorkingDir, spaceId])

  return { change, status, available }
}
