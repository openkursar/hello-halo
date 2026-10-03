/**
 * Guard: file-system events and file lists stay bounded end to end.
 *
 * - File events leave the main process only as `artifact:changed-batch` (per
 *   flush, per space) and `artifact:tree-update`; a per-file event channel
 *   costs one IPC send and one WebSocket frame per changed file.
 * - Every worker process survives a stray promise rejection instead of exiting
 *   and being restarted into the same failure.
 * - The renderer never holds or sorts a whole file list: file search goes
 *   through the path index (`queryArtifactFiles`), and memoized derivations in
 *   the file tree / @ menu do not sort.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { REPO_ROOT, findMatches, formatMatches, listSourceFiles, readSource } from './lib/source-scan'

const ALL_SOURCES = listSourceFiles('src')
const RENDERER_SOURCES = listSourceFiles('src/renderer')

/** Source text of every `useMemo(...)` call, found by paren matching. */
function useMemoBodies(source: string): string[] {
  const bodies: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf('useMemo(', from)
    if (start === -1) return bodies
    let depth = 0
    let end = start + 'useMemo'.length
    for (; end < source.length; end++) {
      const ch = source[end]
      if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) break
    }
    bodies.push(source.slice(start, end + 1))
    from = end + 1
  }
}

describe('file events guard', () => {
  it('has no per-file change event channel', () => {
    const perFile = findMatches(ALL_SOURCES, /['"`]artifact:changed['"`]/)
    expect(perFile, formatMatches(perFile)).toEqual([])
  })

  it('broadcasts file events only on the batch and tree-update channels', () => {
    const sends = findMatches(listSourceFiles('src/main'), /broadcastToAllClients\(\s*['"`]artifact:/)
    const channels = new Set(sends.map(m => /['"`](artifact:[^'"`]+)['"`]/.exec(m.text)?.[1]))
    expect([...channels].sort(), formatMatches(sends)).toEqual(['artifact:changed-batch', 'artifact:tree-update'])
  })

  it('keeps the renderer subscribed to the batch channel', () => {
    const transport = readSource('src/renderer/api/transport.ts')
    expect(transport).toContain(`'artifact:changed-batch': 'onArtifactChangedBatch'`)
    expect(readSource('src/preload/index.ts')).toContain(`createEventListener('artifact:changed-batch'`)
  })
})

describe('worker processes guard', () => {
  const workerDir = join(REPO_ROOT, 'src/worker')
  const entries = readdirSync(workerDir)
    .map(name => `src/worker/${name}/index.ts`)
    .filter(file => existsSync(join(REPO_ROOT, file)))

  it('finds the worker entry points', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  for (const entry of entries) {
    it(`${entry} handles unhandled promise rejections`, () => {
      expect(readSource(entry)).toMatch(/process\.on\(\s*['"]unhandledRejection['"]/)
    })
  }
})

describe('renderer file lists guard', () => {
  it('never fetches a whole flat file list', () => {
    const calls = findMatches(
      RENDERER_SOURCES.filter(file => !file.startsWith('src/renderer/api/')),
      /\blistArtifacts\(/
    )
    expect(calls, formatMatches(calls)).toEqual([])
  })

  it('does not sort inside memoized derivations of the file tree or the @ menu', () => {
    const files = [
      ...RENDERER_SOURCES.filter(file => file.startsWith('src/renderer/components/artifact/')),
      'src/renderer/components/chat/InputArea.tsx',
    ]
    const offenders = files.flatMap(file =>
      useMemoBodies(readSource(file))
        .filter(body => /\.sort\(|\.toSorted\(/.test(body))
        .map(body => `${file}: ${body.slice(0, 80).replace(/\s+/g, ' ')}…`)
    )
    expect(offenders).toEqual([])
  })

  it('tells the user when @ file results are partial because the index is still building', () => {
    const inputArea = readSource('src/renderer/components/chat/InputArea.tsx')
    // Formatting-agnostic: the hook's `indexing` field is bound to the name the
    // hint reads, wherever it sits in the destructure.
    const destructure = /const\s*\{([^}]*)\}\s*=\s*useFileMentionQuery\(/.exec(inputArea)
    expect(destructure, 'InputArea destructures useFileMentionQuery').not.toBeNull()
    expect(destructure![1]).toMatch(/(^|[\s,])indexing\s*:\s*mentionFilesIndexing\s*(,|$)/)
    expect(inputArea).toMatch(/mentionFilesIndexing\s*&&[\s\S]{0,120}?t\(\s*'Indexing files…'\s*\)/)
  })
})
