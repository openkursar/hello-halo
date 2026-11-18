/**
 * useServerBackend — whether this client is driving a headless server.
 *
 * A web client looks the same whether its backend is a headless server or a
 * desktop shared over Remote Access. The difference matters for node-level
 * settings: a desktop owner changes them in the desktop window, while a server
 * has no window, so its web client is the only place left to do it.
 *
 * Fixed for the life of the backend process, so it is fetched once per
 * renderer and shared. `false` while loading and on any failure: settings stay
 * hidden rather than briefly appearing on a desktop-backed web client. The
 * HTTP routes behind those settings enforce their own auth either way — this
 * is a UX gate, not a security boundary.
 */

import { useEffect, useState } from 'react'
import { api } from '../api'

let cached: Promise<boolean> | null = null

async function fetchServerBackend(): Promise<boolean> {
  try {
    const res = await api.getRuntimeInfo()
    return res.success === true && res.data?.serverMode === true
  } catch (error) {
    console.error('[useServerBackend] Fetch failed, assuming a desktop backend:', error)
    return false
  }
}

export function useServerBackend(): boolean {
  const [serverBackend, setServerBackend] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!cached) cached = fetchServerBackend()
    cached.then((value) => {
      if (!cancelled) setServerBackend(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return serverBackend
}
