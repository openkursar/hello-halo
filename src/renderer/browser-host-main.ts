import { mountBrowserHost } from './browser-host'

const container = document.getElementById('browser-host')!
const host = mountBrowserHost(container, window.halo)
window.addEventListener('unload', () => host.dispose(), { once: true })
