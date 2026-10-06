import type { BrowserHostBridge, BrowserHostCommand, BrowserHostPage } from '../../shared/types/browser-host'
import { getBrowserSurface, subscribeBrowserSurfaces } from './surfaces'

interface GuestEntry {
  page: BrowserHostPage
  element: HTMLElement
  surfaceClaimed: boolean
  width: number
  height: number
  frameLeaseId?: string
  readyFrame?: number
}

export interface BrowserHost {
  ready: Promise<void>
  dispose(): void
}

/** One fixed DOM attachment per guest, until its owner explicitly removes it. */
export function mountBrowserHost(container: HTMLElement, bridge: BrowserHostBridge): BrowserHost {
  const document = container.ownerDocument
  const win = document.defaultView!
  const guests = new Map<string, GuestEntry>()
  const changedDuringSnapshot = new Set<string>()
  let snapshotPending = true
  let disposed = false

  const cancelFrameReady = (entry: GuestEntry) => {
    if (entry.readyFrame !== undefined) win.cancelAnimationFrame(entry.readyFrame)
    entry.readyFrame = undefined
  }

  const scheduleFrameReady = (entry: GuestEntry) => {
    const { id, token, frameLeaseId } = entry.page
    if (entry.frameLeaseId === frameLeaseId) return
    cancelFrameReady(entry)
    entry.frameLeaseId = frameLeaseId
    if (!frameLeaseId) return

    const isCurrent = () => !disposed && guests.get(id) === entry && entry.element.isConnected &&
      entry.page.token === token && entry.page.frameLeaseId === frameLeaseId

    // Hidden input and screenshots need committed in-viewport geometry.
    entry.readyFrame = win.requestAnimationFrame(() => {
      entry.readyFrame = undefined
      if (!isCurrent()) return
      entry.readyFrame = win.requestAnimationFrame(() => {
        entry.readyFrame = undefined
        if (isCurrent()) bridge.browserHostFrameReady({ id, token, frameLeaseId })
      })
    })
  }

  const present = (entry: GuestEntry) => {
    const { page, element } = entry
    const surface = getBrowserSurface(page.id)
    if (surface) entry.surfaceClaimed = true
    const rect = surface?.element.getBoundingClientRect()
    const hasSurface = surface?.enabled && surface.element.isConnected && rect && rect.width > 0 && rect.height > 0
    const visible = page.visible && (!entry.surfaceClaimed || !!hasSurface)
    let x = page.bounds.x
    let y = page.bounds.y
    if (visible && rect) {
      entry.width = Math.min(page.viewportWidth ?? rect.width, rect.width)
      entry.height = rect.height
      x = rect.x + (rect.width - entry.width) / 2
      y = rect.y
    } else if ((visible || !page.frameLeaseId) && page.bounds.width > 0 && page.bounds.height > 0) {
      entry.width = page.bounds.width
      entry.height = page.bounds.height
    }

    // A frame lease exposes a compositor surface without exposing pixels or pointer input.
    const leasedHidden = !visible && !!page.frameLeaseId
    Object.assign(element.style, {
      left: `${visible ? x : leasedHidden ? 0 : -100000}px`,
      top: `${visible ? y : leasedHidden ? 0 : -100000}px`,
      width: `${entry.width}px`,
      height: `${entry.height}px`,
      opacity: leasedHidden ? '0' : '1',
      pointerEvents: visible ? 'auto' : 'none',
    })
    element.tabIndex = visible ? 0 : -1
    element.setAttribute('aria-hidden', String(!visible))
    if (!visible && document.activeElement === element) element.blur()
    scheduleFrameReady(entry)
  }

  const remove = (id: string, token: string) => {
    const entry = guests.get(id)
    if (!entry || entry.page.token !== token) return
    cancelFrameReady(entry)
    guests.delete(id)
    entry.element.remove()
  }

  const upsert = (page: BrowserHostPage) => {
    let entry = guests.get(page.id)
    if (entry?.page.token !== page.token) {
      if (entry) remove(page.id, entry.page.token)
      const element = document.createElement('webview')
      element.dataset.browserPageId = page.id
      element.dataset.browserPageToken = page.token
      element.setAttribute('partition', 'persist:browser')
      element.setAttribute('allowpopups', '')
      element.setAttribute('plugins', '')
      element.setAttribute('src', page.src)
      Object.assign(element.style, {
        position: 'fixed',
        display: 'flex',
        border: '0',
        zIndex: '1',
      })
      entry = {
        page,
        element,
        surfaceClaimed: false,
        width: page.bounds.width > 0 ? page.bounds.width : 1280,
        height: page.bounds.height > 0 ? page.bounds.height : 720,
      }
      guests.set(page.id, entry)
      try {
        present(entry)
        container.appendChild(element)
      } catch (error) {
        remove(page.id, page.token)
        console.error('[BrowserHost] Guest attachment failed:', page.id, error)
        bridge.browserHostFailed({ id: page.id, token: page.token, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    entry.page = page
    present(entry)
  }

  const onCommand = (command: BrowserHostCommand) => {
    if (disposed) return
    const id = command.type === 'upsert' ? command.page.id : command.id
    if (snapshotPending) changedDuringSnapshot.add(id)
    if (command.type === 'upsert') upsert(command.page)
    else remove(command.id, command.token)
  }

  const unsubscribe = bridge.onBrowserHostCommand(onCommand)
  const unsubscribeSurfaces = subscribeBrowserSurfaces(id => {
    const entry = guests.get(id)
    if (entry) present(entry)
  })
  const ready = bridge.browserHostReady().then(pages => {
    if (disposed) return
    for (const page of pages) {
      if (!changedDuringSnapshot.has(page.id)) upsert(page)
    }
  }).catch(error => {
    if (!disposed) console.error('[BrowserHost] Initial page snapshot failed:', error)
  }).finally(() => {
    snapshotPending = false
    changedDuringSnapshot.clear()
  })

  return {
    ready,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      unsubscribeSurfaces()
      for (const entry of guests.values()) {
        cancelFrameReady(entry)
        entry.element.remove()
      }
      guests.clear()
      changedDuringSnapshot.clear()
    },
  }
}

/** Returns focus only to a currently presented guest. */
export function focusBrowserPage(id: string): boolean {
  if (!document.hasFocus()) return false
  for (const element of document.querySelectorAll<HTMLElement>('webview[data-browser-page-id]')) {
    if (element.dataset.browserPageId === id && element.getAttribute('aria-hidden') === 'false') {
      element.focus()
      return true
    }
  }
  return false
}
