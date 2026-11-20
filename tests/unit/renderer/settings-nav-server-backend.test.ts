/**
 * Settings navigation per client: the desktop shows every section; a web client
 * of a shared desktop hides the node-level ones (the owner changes them in the
 * desktop window); a web client of a headless server gets Advanced and the
 * federation gateway back, since that server has no window of its own.
 */

import { describe, expect, it } from 'vitest'
import { getFilteredNavItems } from '../../../src/renderer/components/settings/nav-config'

const ids = (isRemoteMode: boolean, serverBackend?: boolean) =>
  getFilteredNavItems(isRemoteMode, serverBackend).map(item => item.id)

describe('getFilteredNavItems', () => {
  it('keeps the desktop gateway under Remote Access', () => {
    expect(ids(false)).toEqual(expect.arrayContaining(['system', 'advanced', 'remote']))
    expect(ids(false)).not.toContain('federation')
  })

  it('hides node-level sections from a web client of a desktop', () => {
    const remote = ids(true)
    for (const id of ['system', 'advanced', 'remote', 'federation']) expect(remote).not.toContain(id)
    expect(ids(true, false)).toEqual(remote)
  })

  it('shows Advanced and Federation, but not System or Remote Access, to a web client of a server', () => {
    const server = ids(true, true)
    expect(server).toEqual(expect.arrayContaining(['advanced', 'federation']))
    expect(server).not.toContain('system')
    expect(server).not.toContain('remote')
  })

})
