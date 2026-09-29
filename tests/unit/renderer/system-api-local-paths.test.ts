/**
 * Local paths only mean something on the machine running Halo, so a remote
 * client can neither pick nor resolve them.
 */

import { expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/api/_shared', () => ({ isElectron: () => false, httpRequest: vi.fn() }))

import { systemApi } from '../../../src/renderer/api/system.api'

it('a remote client cannot open the native picker', async () => {
  expect(await systemApi.pickLocalEntries()).toEqual({ success: false, error: 'Only available in desktop app' })
})

it('a remote client gets no path for a dropped file', () => {
  expect(systemApi.getPathForFile({} as File)).toBe('')
})
