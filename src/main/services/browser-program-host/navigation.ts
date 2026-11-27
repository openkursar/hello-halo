import { browserViewManager } from '../browser-view.service'
import { fail } from './protocol'

export function navigationFailed(viewId: string, failure?: string): never {
  const state = browserViewManager.getState(viewId)
  if (state?.blockedByPolicy) return fail('BROWSER_POLICY_BLOCKED', 'Navigation blocked by browser policy.')
  // Chromium messages may contain URLs with credentials or query values.
  const reason = (failure || state?.error)?.match(/\bERR_[A-Z0-9_]+\b/)?.[0]
  return fail('HOST_NAVIGATION_FAILED', reason ? `Navigation failed: ${reason}.` : 'Navigation did not complete.')
}

/** Observe only this WebCLI navigation; native browser state and policy stay unchanged. */
export async function navigateForProgram(viewId: string, url: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const contents = browserViewManager.getWebContents(viewId)
  if (!contents || contents.isDestroyed()) return fail('HOST_PAGE_UNAVAILABLE', 'Browser page is unavailable.')
  let failure: string | undefined
  const onFailure = (_event: Electron.Event, code: number, reason: string, _url: string, main: boolean) => {
    if (main && code !== -3) failure = reason || `Error ${code}`
  }
  let stopped: (() => void) | undefined
  let abort!: () => void
  let destroyed!: () => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(signal.reason ?? new Error('Navigation cancelled.'))
      if (!contents.isDestroyed()) contents.stop()
    }
    destroyed = () => reject(Object.assign(new Error('Browser page closed during navigation.'), { code: 'HOST_PAGE_UNAVAILABLE' }))
    timer = setTimeout(() => {
      reject(Object.assign(new Error('Navigation did not finish in time.'), { code: 'HOST_NAVIGATION_TIMEOUT' }))
      if (!contents.isDestroyed()) contents.stop()
    }, 30000)
  })
  contents.on('did-fail-load', onFailure)
  contents.once('destroyed', destroyed)
  signal.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([interrupted, (async () => {
      signal.throwIfAborted()
      const ok = await browserViewManager.navigate(viewId, url)
      signal.throwIfAborted()
      if (!ok) return navigationFailed(viewId, failure)
      // loadURL can settle on the preceding attachment document's finish event.
      // Keep failure evidence until the requested main-frame load actually stops.
      if (contents.isLoadingMainFrame()) await new Promise<void>(resolve => {
        stopped = resolve
        contents.once('did-stop-loading', stopped)
        if (!contents.isLoadingMainFrame()) resolve()
      })
      signal.throwIfAborted()
      if (failure) navigationFailed(viewId, failure)
    })()])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    contents.removeListener('destroyed', destroyed)
    contents.removeListener('did-fail-load', onFailure)
    if (stopped) {
      contents.removeListener('did-stop-loading', stopped)
      stopped()
    }
  }
}

export function assertNavigationComplete(viewId: string): void {
  const state = browserViewManager.getState(viewId)
  if (!state || state.error || state.blockedByPolicy) navigationFailed(viewId)
  if (state.isLoading) fail('HOST_NAVIGATION_TIMEOUT', 'Navigation is still loading; no page action was performed.')
}
