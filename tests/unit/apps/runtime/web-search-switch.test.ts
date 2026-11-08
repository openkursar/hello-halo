/**
 * The digital human's web-search switch: on by default, and what turning it
 * off withholds from its sessions.
 */

import { describe, it, expect } from 'vitest'

import { withheldWebSearch, withholdWebSearchBuiltins } from '../../../../src/main/apps/runtime/web-search-switch'
import { WEB_SEARCH_PERMISSION, isWebSearchEnabled } from '../../../../src/shared/apps/app-types'
import { filterMcpServersByPolicy } from '../../../../src/main/apps/runtime/capability-policy'

const appWith = (permissions: { granted?: string[]; denied?: string[] }, specPermissions?: string[]) =>
  ({ permissions: { granted: [], denied: [], ...permissions }, spec: { permissions: specPermissions } }) as any

const switchedOff = () => appWith({ denied: [WEB_SEARCH_PERMISSION] })

describe('the switch', () => {
  it('is on unless the owner turns it off, and a denial beats the spec', () => {
    expect(isWebSearchEnabled(appWith({}))).toBe(true)
    expect(isWebSearchEnabled(switchedOff())).toBe(false)
    expect(isWebSearchEnabled(appWith({ denied: [WEB_SEARCH_PERMISSION] }, [WEB_SEARCH_PERMISSION]))).toBe(false)
  })
})

describe('withheldWebSearch', () => {
  it('withholds nothing while on', () => {
    expect(withheldWebSearch(appWith({}))).toEqual({ servers: [], builtins: [] })
  })

  it('withholds Halo web search and the engine\'s own search tool while off', () => {
    expect(withheldWebSearch(switchedOff())).toEqual({
      servers: ['web-search'],
      builtins: ['WebSearch'],
    })
  })

  it('leaves opening a given web page alone while off', () => {
    expect(withheldWebSearch(switchedOff()).builtins).not.toContain('WebFetch')
  })

  it('adds to the deny list without dropping or repeating entries', () => {
    const options = { disallowedTools: ['NotebookEdit'] }
    withholdWebSearchBuiltins(options, withheldWebSearch(switchedOff()))
    expect(options.disallowedTools).toEqual(['NotebookEdit', 'WebSearch'])

    withholdWebSearchBuiltins(options, withheldWebSearch(switchedOff()))
    expect(options.disallowedTools).toEqual(['NotebookEdit', 'WebSearch'])

    const untouched: { disallowedTools?: string[] } = {}
    withholdWebSearchBuiltins(untouched, withheldWebSearch(appWith({})))
    expect(untouched).toEqual({})
  })
})

describe('a guest or teammate policy', () => {
  it('keeps web search only where the owner\'s session has it', () => {
    const server = { name: 'web-search' }
    expect(filterMcpServersByPolicy({ 'web-search': server }, null, { allowedTools: [] }, 'strict')).toHaveProperty('web-search')
    // Switched off by the owner: never assembled, so no policy can bring it back.
    expect(filterMcpServersByPolicy({}, null, undefined, 'permissive')).not.toHaveProperty('web-search')
  })
})
