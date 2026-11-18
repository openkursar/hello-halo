import { test as base } from './acceptance-app'
import { withRemoteDesktop, type RemoteDesktop } from './acceptance-remote-lifecycle'

export const test = base.extend<{ remoteDesktop: RemoteDesktop }>({
  remoteDesktop: async ({ acceptanceApp, browser }, use, info) => {
    await withRemoteDesktop(acceptanceApp, browser, use, info)
  },
})
export { acceptance, expect } from './acceptance-app'
