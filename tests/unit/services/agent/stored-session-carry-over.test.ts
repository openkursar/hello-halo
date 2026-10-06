/**
 * When a space's working directory changes, the sessions the engine stored for
 * the old folder are copied to the new folder's name, so conversations resume
 * with their memory: the old copies stay, a newer copy wins, and the name is
 * the one the engine itself looks under.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../../../src/main/foundation/config.service', () => ({ resolveClaudeConfigDir: () => '/nonexistent-config' }))

import { copyStoredSessions, projectDirName } from '../../../../src/main/services/agent/stored-session'

let configDir: string
let root: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'halo-engine-config-'))
  root = realpathSync(mkdtempSync(join(tmpdir(), 'halo-work-')))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

const projectsOf = (workDir: string) => join(configDir, 'projects', projectDirName(workDir))

function storedSession(workDir: string, sessionId: string, content = '{"turn":1}\n') {
  const dir = projectsOf(workDir)
  mkdirSync(join(dir, sessionId, 'subagents'), { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), content)
  writeFileSync(join(dir, sessionId, 'subagents', 'agent-1.jsonl'), '{}\n')
  return join(dir, `${sessionId}.jsonl`)
}

describe('copyStoredSessions', () => {
  it('copies each session and its folder to the new folder’s name and leaves the old ones', async () => {
    const oldDir = join(root, 'old')
    const newDir = join(root, 'new')
    mkdirSync(oldDir)
    mkdirSync(newDir)
    const original = storedSession(oldDir, 'session-1')
    storedSession(oldDir, 'session-2')

    expect(await copyStoredSessions(oldDir, newDir, configDir)).toBe(2)

    expect(readFileSync(join(projectsOf(newDir), 'session-1.jsonl'), 'utf8')).toBe('{"turn":1}\n')
    expect(existsSync(join(projectsOf(newDir), 'session-1', 'subagents', 'agent-1.jsonl'))).toBe(true)
    expect(existsSync(join(projectsOf(newDir), 'session-2.jsonl'))).toBe(true)
    expect(existsSync(original)).toBe(true)
  })

  it('finds the sessions of an old folder that no longer exists', async () => {
    const goneDir = join(root, 'deleted-by-desktop-redirection')
    const newDir = join(root, 'new')
    mkdirSync(newDir)
    // Stored while the folder existed; the folder itself is gone now.
    storedSession(goneDir, 'session-1')

    expect(await copyStoredSessions(goneDir, newDir, configDir)).toBe(1)
    expect(existsSync(join(projectsOf(newDir), 'session-1.jsonl'))).toBe(true)
  })

  it('keeps the newer copy when the folder changes back and forth', async () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    const inA = storedSession(a, 'session-1', '{"turn":1}\n')
    const inB = storedSession(b, 'session-1', '{"turn":1}\n{"turn":2}\n')
    utimesSync(inA, new Date(1_000_000), new Date(1_000_000))
    utimesSync(inB, new Date(2_000_000), new Date(2_000_000))

    // Back to A: B's later turns win over A's older copy...
    await copyStoredSessions(b, a, configDir)
    expect(readFileSync(inA, 'utf8')).toBe('{"turn":1}\n{"turn":2}\n')

    // ...and an older copy never replaces a newer one.
    writeFileSync(inA, '{"turn":1}\n{"turn":2}\n{"turn":3}\n')
    utimesSync(inB, new Date(1_000_000), new Date(1_000_000))
    expect(await copyStoredSessions(b, a, configDir)).toBe(0)
    expect(readFileSync(inA, 'utf8')).toBe('{"turn":1}\n{"turn":2}\n{"turn":3}\n')
  })

  it('files them under the resolved folder, as the engine does for a folder reached through a link', async () => {
    const oldDir = join(root, 'old')
    const real = join(root, 'real-new')
    const link = join(root, 'linked-new')
    mkdirSync(oldDir)
    mkdirSync(real)
    symlinkSync(real, link)
    storedSession(oldDir, 'session-1')

    await copyStoredSessions(oldDir, link, configDir)

    expect(existsSync(join(projectsOf(real), 'session-1.jsonl'))).toBe(true)
  })

  it('copies nothing when the old folder has no stored sessions', async () => {
    const newDir = join(root, 'new')
    mkdirSync(newDir)

    expect(await copyStoredSessions(join(root, 'never-used'), newDir, configDir)).toBe(0)
    expect(existsSync(projectsOf(newDir))).toBe(false)
  })
})

describe('projectDirName', () => {
  it('names a long folder exactly as the engine does', () => {
    // Taken from the engine itself: its project-dir naming run on this path.
    const longWorkDir = `/Users/me/${'nested-folder/'.repeat(20)}work`
    const name = projectDirName(longWorkDir)

    expect(name).toBe(`${longWorkDir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-kqo0lq`)
    expect(projectDirName('/Users/me/Halo work')).toBe('-Users-me-Halo-work')
  })
})
