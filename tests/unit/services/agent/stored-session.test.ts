/**
 * Deleting what a CC-protocol engine stored for one session: its transcript and
 * its side folder, in the project folder named after the working directory —
 * and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../../../src/main/foundation/config.service', () => ({ resolveClaudeConfigDir: () => '/nonexistent-config' }))

import { deleteStoredSession } from '../../../../src/main/services/agent/stored-session'

let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'halo-engine-config-'))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

/** Lay out a session the way the engine stores it; returns its two paths. */
function storedSession(projectDir: string, sessionId: string) {
  const dir = join(configDir, 'projects', projectDir)
  mkdirSync(join(dir, sessionId, 'subagents'), { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{}\n')
  writeFileSync(join(dir, sessionId, 'subagents', 'agent-1.jsonl'), '{}\n')
  return { transcript: join(dir, `${sessionId}.jsonl`), folder: join(dir, sessionId) }
}

describe('deleteStoredSession', () => {
  const workDir = '/Users/me/.halo/spaces/sales_team/work'
  const projectDir = '-Users-me--halo-spaces-sales-team-work'

  it('removes the session’s transcript and folder and leaves other sessions alone', () => {
    const gone = storedSession(projectDir, '7d1f0c2e-1111-4a5b-9c8d-000000000001')
    const kept = storedSession(projectDir, '7d1f0c2e-1111-4a5b-9c8d-000000000002')

    deleteStoredSession(workDir, '7d1f0c2e-1111-4a5b-9c8d-000000000001', configDir)

    expect(existsSync(gone.transcript)).toBe(false)
    expect(existsSync(gone.folder)).toBe(false)
    expect(existsSync(kept.transcript)).toBe(true)
    expect(existsSync(kept.folder)).toBe(true)
  })

  it('finds a long working directory by the prefix the default engine cuts it to', () => {
    const longWorkDir = `/Users/me/${'nested-folder/'.repeat(20)}work`
    const name = longWorkDir.replace(/[^a-zA-Z0-9]/g, '-')
    const session = storedSession(`${name.slice(0, 200)}-1x2y3z`, 'abc-123')

    deleteStoredSession(longWorkDir, 'abc-123', configDir)

    expect(existsSync(session.transcript)).toBe(false)
    expect(existsSync(session.folder)).toBe(false)
  })

  it('finds a session stored under the resolved path of a linked working directory', () => {
    const realDir = join(configDir, 'real-work')
    const linkDir = join(configDir, 'linked-work')
    mkdirSync(realDir)
    symlinkSync(realDir, linkDir, 'dir')
    const session = storedSession(realpathSync(realDir).replace(/[^a-zA-Z0-9]/g, '-'), 'linked-session')

    deleteStoredSession(linkDir, 'linked-session', configDir)

    expect(existsSync(session.transcript)).toBe(false)
  })

  it('finds a session stored under the NFC form of the working directory', () => {
    const decomposed = '/Users/me/cafe\u0301'
    const session = storedSession(decomposed.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-'), 'accented-session')

    deleteStoredSession(decomposed, 'accented-session', configDir)

    expect(existsSync(session.transcript)).toBe(false)
  })

  it('is fine when nothing was stored', () => {
    expect(() => deleteStoredSession(workDir, 'never-stored', configDir)).not.toThrow()
  })

  it('refuses a session id that is not a plain name', () => {
    const victim = storedSession(projectDir, 'victim')
    writeFileSync(join(configDir, 'projects', 'outside.jsonl'), '{}\n')

    deleteStoredSession(workDir, '../outside', configDir)
    deleteStoredSession(workDir, '..', configDir)

    expect(existsSync(join(configDir, 'projects', 'outside.jsonl'))).toBe(true)
    expect(existsSync(victim.folder)).toBe(true)
  })
})
