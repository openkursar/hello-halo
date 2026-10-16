import { mountBrowserHost } from '../../../src/renderer/browser-host'
import type { BrowserHostBridge } from '../../../src/shared/types/browser-host'

const halo = (window as unknown as { halo: BrowserHostBridge }).halo

// A test can make this host stop attaching new pages, as a stalled main window
// does; pages it already holds keep working.
const control = { stallNewPages: false }
const mounted = new Set<string>()
;(window as unknown as { browserHostTest: typeof control }).browserHostTest = control

const bridge: BrowserHostBridge = {
  browserHostReady: () => halo.browserHostReady().then(pages => {
    for (const page of pages) mounted.add(page.id)
    return pages
  }),
  browserHostFailed: failure => halo.browserHostFailed(failure),
  browserHostFrameReady: ready => halo.browserHostFrameReady(ready),
  onBrowserHostCommand: callback => halo.onBrowserHostCommand(command => {
    if (command.type === 'remove') mounted.delete(command.id)
    else if (!mounted.has(command.page.id)) {
      if (control.stallNewPages) return
      mounted.add(command.page.id)
    }
    callback(command)
  }),
}

void mountBrowserHost(document.body, bridge).ready
