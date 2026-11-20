import { useState, useEffect } from 'react'
import { api } from '../api'
import type { ActivityEntryContent } from '../../shared/apps/app-types'

export function useDataContent(content: ActivityEntryContent): { text?: string; unreadable: boolean } {
  const path = content.dataPath
  const inline = typeof content.data === 'string' && content.data ? content.data : undefined
  const [file, setFile] = useState<{ path: string; text?: string } | null>(null)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    void api.readArtifactContent(path).then(result => {
      if (cancelled) return
      const data = result.data as { content?: unknown; encoding?: string } | undefined
      if (result.success && typeof data?.content === 'string' && data.encoding !== 'base64') {
        setFile({ path, text: data.content })
      } else {
        console.warn('[Activity] Report preview unavailable:', result.error ?? 'No text preview')
        setFile({ path })
      }
    }).catch(error => {
      if (cancelled) return
      console.warn('[Activity] Report preview failed:', error)
      setFile({ path })
    })
    return () => { cancelled = true }
  }, [path])

  if (file && file.path === path) return { text: file.text ?? inline, unreadable: file.text === undefined && !inline }
  return { text: inline, unreadable: false }
}
