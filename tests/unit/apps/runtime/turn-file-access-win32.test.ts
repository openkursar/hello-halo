/**
 * The search-output boundary under Windows path rules: drive letters, either
 * separator, case-insensitive names. Node's win32 path module stands in for the
 * platform; the filesystem is never reached for these made-up paths.
 */

import { afterAll, describe, expect, it, vi } from 'vitest'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { value: 'win32' })
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return { ...actual.win32, default: actual.win32 }
})

const { filterSearchOutput, searchPathRewrite } = await import('../../../../src/main/apps/runtime/turn-file-access')

afterAll(() => { Object.defineProperty(process, 'platform', platform) })

const space = 'C:\\Users\\ada\\space'
const access = {
  cwd: space,
  memoryWritable: [`${space}\\.halo\\apps\\dh\\memory.md`, `${space}\\.halo\\apps\\dh\\memory\\topics`],
  memoryReadable: [],
  attachedFiles: [],
  workspaceRoots: [space],
  closed: [`${space}\\.halo`],
  hookGuarded: [],
  memorySystemPaths: [],
}

describe('Windows spellings of a search path', () => {
  it('rewrites forward slashes, `.` and `..` to the resolved path', () => {
    for (const path of ['C:/Users/ada/space', 'C:/Users/ada/space/./', 'C:\\Users\\ada\\space\\src\\..', 'c:\\users\\ada\\space\\.']) {
      expect(searchPathRewrite('Grep', { pattern: 'x', path }, space)?.path ?? path, path).toMatch(/^[Cc]:\\Users\\ada\\space$/i)
    }
  })

  it('drops closed lines however the engine spelled the path', () => {
    const lines = (prefix: string) => [
      `${prefix}/src/a.ts:1:SECRET`,
      `${prefix}/.halo/apps/dh/runs/chat-alice.jsonl:1:SECRET-ALICE`,
      `${prefix}\\.halo\\apps\\dh\\runs\\chat-alice.jsonl:2:SECRET-ALICE`,
      `${prefix}/.halo/apps/dh/memory/topics/faq.md:1:SECRET`,
    ].join('\n')
    for (const path of ['C:/Users/ada/space', 'C:/Users/ada/space/./', 'C:\\Users\\ada\\space\\src\\..', 'c:/USERS/ada/space']) {
      const out = filterSearchOutput(access, 'Grep', { pattern: 'SECRET', path }, lines(path))!
      expect(out, path).not.toContain('ALICE')
      expect(out).toContain('src/a.ts:1:SECRET')
      expect(out).toContain('faq.md:1:SECRET')
    }
  })

  it('a match only in .halo reads as none', () => {
    const out = filterSearchOutput(
      access, 'Grep', { pattern: 'SECRET-A', path: 'C:/Users/ada/space/' },
      'C:/Users/ada/space/.halo/apps/dh/runs/chat-alice.jsonl:1:SECRET-ALICE'
    )
    expect(out).toBe('No matches found for pattern "SECRET-A" in C:/Users/ada/space/. Check the pattern syntax (ripgrep regex), broaden the pattern, or search a different path.')
  })
})
