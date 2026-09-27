import { describe, expect, it } from 'vitest'
import { getMemoryBaseDir, resolveMemoryLayout } from '../../../../src/main/platform/memory/paths'
import type { MemoryCallerScope } from '../../../../src/main/platform/memory/types'

describe('app identity storage', () => {
  const caller: MemoryCallerScope = {
    type: 'app', appId: 'person', spaceId: 'new-space', spacePath: '/new-space',
    appDataPath: '/original-space/.halo/apps/person',
  }

  it('retains app memory while space memory follows the execution environment', () => {
    expect(getMemoryBaseDir(caller, 'app')).toBe('/original-space/.halo/apps/person')
    expect(getMemoryBaseDir(caller, 'space')).toBe('/new-space/.halo')
    const layout = resolveMemoryLayout(caller, 'app')
    expect(layout.file).toBe('/original-space/.halo/apps/person/memory.md')
    expect(layout.topicsDir).toBe('/original-space/.halo/apps/person/memory/topics')
    expect(layout.runDir).toBe('/original-space/.halo/apps/person/memory/run')
    expect(resolveMemoryLayout(caller, 'space').file).toBe('/new-space/.halo/memory.md')
  })

  it('keeps the legacy layout and requires an app id for app memory', () => {
    expect(getMemoryBaseDir({ ...caller, appDataPath: undefined }, 'app')).toBe('/new-space/.halo/apps/person')
    expect(() => getMemoryBaseDir({ ...caller, appId: undefined }, 'app')).toThrow('requires an appId')
  })
})
