/**
 * useDataContent - Load activity entry data from inline content or file path
 *
 * When an activity entry has `dataPath`, reads the file via the artifact API
 * and returns its content. Supports both Electron (IPC) and remote (HTTP) modes.
 *
 * A failed read is reported rather than swallowed: entries recorded before
 * output containment landed can point outside the space, which the desktop
 * still opens but the headless build refuses, and a caller that silently
 * renders nothing leaves the user staring at a filename with no explanation.
 *
 * Usage:
 *   const { text, unreadable } = useDataContent(entry.content)
 */

import { useState, useEffect } from 'react'
import { api } from '../api'
import type { ActivityEntryContent } from '../../shared/apps/app-types'

export interface DataContent {
  /** Markdown to render, or undefined when there is nothing to show. */
  text?: string
  /** The entry names a file, and reading it failed. */
  unreadable: boolean
}

/**
 * Resolve the renderable markdown content from an activity entry.
 *
 * Priority: dataPath (file) > data (inline string) > undefined
 */
export function useDataContent(content: ActivityEntryContent): DataContent {
  const inlineData = typeof content.data === 'string' ? content.data : undefined
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (!content.dataPath) return

    let cancelled = false
    setLoadFailed(false)

    api.readArtifactContent(content.dataPath)
      .then((res: any) => {
        if (cancelled) return
        if (res?.success && res.data?.content) {
          setFileContent(res.data.content)
        } else {
          console.warn('[useDataContent] Unexpected response shape:', res)
          setLoadFailed(true)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.warn('[useDataContent] Failed to read file:', content.dataPath, err)
        setLoadFailed(true)
      })

    return () => { cancelled = true }
  }, [content.dataPath])

  if (content.dataPath && !loadFailed && fileContent !== null) {
    return { text: fileContent, unreadable: false }
  }
  // Inline data is a usable substitute even when the file read failed; the
  // failure only matters when it leaves nothing to show.
  return { text: inlineData, unreadable: loadFailed && inlineData === undefined }
}
