/**
 * The one entry both IPC and HTTP use to rename or remove a tag across a list.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ rename: vi.fn() }))
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: () => ({ renameTag: state.rename }) }))
const listAppTags = vi.hoisted(() => vi.fn(() => [{ name: 'Ops', count: 2 }]))
vi.mock('../../../src/main/apps/runtime', () => ({ getAppRuntime: () => null, listAppTags }))
vi.mock('../../../src/main/services/agent', () => ({ assertEngineSourceSelection: vi.fn(), resolveDefaultEngine: async () => 'halo' }))

import { listTags, renameTag } from '../../../src/main/controllers/app.controller'

beforeEach(() => { state.rename.mockReset().mockReturnValue(3) })

it('renames or removes a tag on one list and says how many items changed', () => {
  expect(renameTag({ type: 'automation', from: 'Ops', to: 'Monitoring' })).toEqual({ success: true, data: { changed: 3 } })
  expect(renameTag({ type: 'mcp', from: 'Ops', to: null })).toEqual({ success: true, data: { changed: 3 } })
  expect(state.rename).toHaveBeenCalledWith('mcp', 'Ops', null)
})

it('refuses an unknown list or a malformed request without touching anything', () => {
  for (const input of [{ type: 'extension', from: 'a', to: 'b' }, { type: 'skill', from: 1, to: 'b' }, { type: 'skill', from: 'a' }, null]) {
    expect(renameTag(input)).toMatchObject({ success: false, code: 'VALIDATION_FAILED' })
  }
  expect(state.rename).not.toHaveBeenCalled()
})

it('reports the manager\'s refusal', () => {
  state.rename.mockImplementation(() => { throw new Error('A tag needs a name') })
  expect(renameTag({ type: 'skill', from: 'a', to: ' ' })).toMatchObject({ success: false, error: 'A tag needs a name' })
})

it('lists one list\'s tags and refuses an unknown list', () => {
  expect(listTags('mcp')).toEqual({ success: true, data: [{ name: 'Ops', count: 2 }] })
  expect(listAppTags).toHaveBeenCalledWith('mcp')
  expect(listTags('extension')).toMatchObject({ success: false, code: 'VALIDATION_FAILED' })
  expect(listTags(undefined)).toMatchObject({ success: false })
})
