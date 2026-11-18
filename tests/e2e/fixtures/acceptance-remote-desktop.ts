import { test as base } from './acceptance-management'
import { withRemoteDesktop, type RemoteDesktop } from './acceptance-remote-lifecycle'

export { installRemoteLoopbackGuard, readRemoteLoopbackGuard, restoreRemoteLoopbackGuard } from './acceptance-remote-lifecycle'
export const test = base.extend<{ remoteDesktop: RemoteDesktop }>({
  remoteDesktop: async ({ managementApp, browser }, use, info) => {
    await withRemoteDesktop(managementApp, browser, use, info)
  },
})

export { expect } from '@playwright/test'
