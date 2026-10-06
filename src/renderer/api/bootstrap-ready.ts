import { isElectron } from './transport'
import { systemApi } from './system.api'

const BOOTSTRAP_TIMEOUT_MS = 30000
let readiness: Promise<void> | null = null

/** First-render reads can precede extended IPC registration; all callers share one readiness check. */
export function ensureExtendedServicesReady(): Promise<void> {
  if (!isElectron()) return Promise.resolve()
  if (readiness) return readiness
  readiness = new Promise<void>((resolve, reject) => {
    let settled = false
    let unsubscribe = () => {}
    const cleanup = () => { clearTimeout(timer); unsubscribe() }
    const ready = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const failed = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      console.warn('[RendererAPI] Extended services readiness failed', error)
      reject(error)
    }
    const timer = setTimeout(() => failed(new Error('Extended services did not become available')), BOOTSTRAP_TIMEOUT_MS)
    try {
      unsubscribe = systemApi.onBootstrapExtendedReady(ready)
      if (settled) unsubscribe()
      void systemApi.getBootstrapStatus().then(status => { if (status.extendedReady) ready() }, failed)
    } catch (error) {
      failed(error)
    }
  }).catch(error => {
    readiness = null
    throw error
  })
  return readiness
}
