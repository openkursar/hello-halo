/**
 * The knowledge folders a turn is handed (bound knowledge bases whose owner
 * allowed guest reading, see getKnowledgeReadDirsForApp) are readable from a
 * restricted (guest) turn, the same way a granted skill's folder is. Nothing
 * else outside the workspace opens up, and they are never writable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decideFileAccess, type TurnFileAccess } from '../../../../src/main/apps/runtime/turn-file-access'

let root: string
let workspace: string
let kbText: string
let otherKbText: string

function access(knowledgeFolders?: string[]): TurnFileAccess {
  return {
    cwd: workspace,
    memoryWritable: [],
    memoryReadable: [],
    attachedFiles: [],
    knowledgeFolders,
    workspaceRoots: [workspace],
    closed: [join(workspace, '.halo')],
    hookGuarded: [],
    memorySystemPaths: [],
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-access-'))
  workspace = join(root, 'space')
  kbText = join(root, 'knowledge-bases', 'kb-shared', 'text')
  otherKbText = join(root, 'knowledge-bases', 'kb-other', 'text')
  for (const d of [workspace, kbText, otherKbText]) mkdirSync(d, { recursive: true })
  writeFileSync(join(kbText, 'a.txt'), 'shared knowledge')
  writeFileSync(join(otherKbText, 'b.txt'), 'not bound')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('knowledge folders in a restricted turn', () => {
  it('reads a bound knowledge base, even when the policy grants no file tools', () => {
    expect(decideFileAccess(access([kbText]), 'Read', { file_path: join(kbText, 'a.txt') }, false)).toEqual({ allow: true })
    expect(decideFileAccess(access([kbText]), 'Read', { file_path: join(kbText, 'a.txt') }, true)).toEqual({ allow: true })
  })

  it('searches inside a bound knowledge base', () => {
    expect(decideFileAccess(access([kbText]), 'Grep', { pattern: 'shared', path: kbText }, true)).toEqual({ allow: true })
    expect(decideFileAccess(access([kbText]), 'Glob', { pattern: join(kbText, '*.txt') }, true)).toEqual({ allow: true })
  })

  it('never writes a bound knowledge base', () => {
    const decision = decideFileAccess(access([kbText]), 'Write', { file_path: join(kbText, 'a.txt'), content: 'x' }, true)
    expect(decision?.allow).toBe(false)
  })

  it('keeps a knowledge base it was not handed closed', () => {
    const decision = decideFileAccess(access([kbText]), 'Read', { file_path: join(otherKbText, 'b.txt') }, true)
    expect(decision?.allow).toBe(false)
  })

  it('behaves as before when no folder is handed', () => {
    const decision = decideFileAccess(access(), 'Read', { file_path: join(kbText, 'a.txt') }, true)
    expect(decision).toEqual({ allow: false, reason: 'Only files inside this workspace can be used here.' })
  })
})
