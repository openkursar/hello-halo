/**
 * Moments when out-of-date model catalogs are worth checking without anyone
 * asking: a Halo window gaining focus (the user came back) and the machine
 * waking from sleep. A signal only asks; CatalogSchedule decides whether any
 * request is made.
 */

import { app, powerMonitor } from 'electron'

export type CatalogSignal = 'focus' | 'resume'

/** The network is usually still reconnecting right after wake; asking at once would only fail. */
const RESUME_DELAY_MS = 10_000

export function watchCatalogSignals(onSignal: (signal: CatalogSignal) => void): () => void {
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  const onFocus = (): void => onSignal('focus')
  const onResume = (): void => {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      onSignal('resume')
    }, RESUME_DELAY_MS)
  }

  app.on('browser-window-focus', onFocus)
  powerMonitor.on('resume', onResume)

  return () => {
    app.removeListener('browser-window-focus', onFocus)
    powerMonitor.removeListener('resume', onResume)
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = null
  }
}
