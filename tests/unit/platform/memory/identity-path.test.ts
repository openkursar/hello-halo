import { describe, expect, it } from 'vitest'
import { getMemoryBaseDir, resolveArchivePath } from '../../../../src/main/platform/memory/paths'
import type { MemoryCallerScope } from '../../../../src/main/platform/memory/types'

describe('app identity storage', () => {
  const caller: MemoryCallerScope = {
    type: 'app', appId: 'person', spaceId: 'new-space', spacePath: '/new-space',
    appDataPath: '/original-space/.halo/apps/person',
  }

  it('retains app memory while space memory follows the execution environment', () => {
    expect(getMemoryBaseDir(caller, 'app')).toBe('/original-space/.halo/apps/person')
    expect(getMemoryBaseDir(caller, 'space')).toBe('/new-space/.halo')
    expect(resolveArchivePath(caller, 'app', 'run/summary.md')).toBe('/original-space/.halo/apps/person/memory/run/summary.md')
  })

  it('keeps the legacy layout and traversal protection', () => {
    expect(getMemoryBaseDir({ ...caller, appDataPath: undefined }, 'app')).toBe('/new-space/.halo/apps/person')
    expect(() => resolveArchivePath(caller, 'app', '../../other-person/memory.md')).toThrow('Path traversal')
    expect(() => getMemoryBaseDir({ ...caller, appId: undefined }, 'app')).toThrow('requires an appId')
  })
})
