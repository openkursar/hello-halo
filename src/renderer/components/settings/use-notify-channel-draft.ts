import { useCallback, useEffect, useRef, useState } from 'react'

type ChannelConfig = Record<string, unknown>

export function useNotifyChannelDraft(onSave: (config: ChannelConfig) => Promise<boolean>) {
  const [draft, setDraft] = useState<ChannelConfig | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const pending = useRef<ChannelConfig | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<{ config: ChannelConfig; result: Promise<boolean> } | null>(null)
  const save = useRef(onSave)
  const mounted = useRef(false)
  useEffect(() => { save.current = onSave }, [onSave])

  const flush = useCallback((): Promise<boolean> => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const config = pending.current
    if (!config) return Promise.resolve(true)
    if (inFlight.current?.config === config) return inFlight.current.result

    const result = save.current(config).then(success => {
      if (inFlight.current?.config === config) inFlight.current = null
      if (pending.current === config) {
        if (success) pending.current = null
        if (mounted.current) {
          setSaveFailed(!success)
          if (success) setDraft(null)
        }
      }
      return success
    })
    inFlight.current = { config, result }
    return result
  }, [])

  const edit = (config: ChannelConfig, immediate = false) => {
    pending.current = config
    setDraft(config)
    setSaveFailed(false)
    if (timer.current !== null) clearTimeout(timer.current)
    if (immediate) return flush()
    timer.current = setTimeout(() => { void flush() }, 500)
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) void flush()
    }
  }, [flush])

  return { draft, edit, flush, saveFailed }
}
