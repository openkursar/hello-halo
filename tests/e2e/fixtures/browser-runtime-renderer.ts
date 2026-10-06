import { mountBrowserHost } from '../../../src/renderer/browser-host'
import type { BrowserHostBridge } from '../../../src/shared/types/browser-host'

const bridge = (window as unknown as { halo: BrowserHostBridge }).halo
void mountBrowserHost(document.body, bridge).ready
