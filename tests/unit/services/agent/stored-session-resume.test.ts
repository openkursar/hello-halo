import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('../../../../src/main/foundation/config.service', () => ({ resolveClaudeConfigDir: () => '/unused' }))
import { prepareStoredSession } from '../../../../src/main/services/agent/stored-session'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'halo-resume-layout-'))
  directories.push(root)
  const work = join(root, 'actual')
  const alias = join(root, 'alias')
  mkdirSync(work)
  symlinkSync(work, alias, 'dir')
  const config = join(root, 'config')
  const native = join(config, 'projects', realpathSync(work).replace(/[^a-zA-Z0-9]/g, '-'))
  const halo = join(config, 'projects', alias.replace(/[^a-zA-Z0-9]/g, '-'))
  return { root, alias, config, native, halo }
}
function writeSession(directory: string, text: string) {
  mkdirSync(join(directory, 'session', 'subagents'), { recursive: true })
  writeFileSync(join(directory, 'session.jsonl'), text)
  writeFileSync(join(directory, 'session', 'subagents', 'agent-a.jsonl'), 'child history')
}

describe('history across external CC and Halo', () => {
  it.each(['halo', 'anthropic'] as const)('copies the other layout into %s without moving the source', async engine => {
    const h = fixture()
    const source = engine === 'halo' ? h.native : h.halo
    const target = engine === 'halo' ? h.halo : h.native
    writeSession(source, 'original context')
    expect(await prepareStoredSession({ workDir: h.alias, sessionId: 'session', configDir: h.config, engine })).toBe(true)
    expect(readFileSync(join(target, 'session.jsonl'), 'utf8')).toBe('original context')
    expect(readFileSync(join(source, 'session.jsonl'), 'utf8')).toBe('original context')
    expect(readFileSync(join(target, 'session', 'subagents', 'agent-a.jsonl'), 'utf8')).toBe('child history')
  })
  it('preserves the destination when both layouts already exist', async () => {
    const h = fixture()
    writeSession(h.native, 'original context')
    writeSession(h.halo, 'newer context')
    expect(await prepareStoredSession({ workDir: h.alias, sessionId: 'session', configDir: h.config, engine: 'halo' })).toBe(true)
    expect(readFileSync(join(h.halo, 'session.jsonl'), 'utf8')).toBe('newer context')
  })
  it('carries newer Halo turns back to CC when their path aliases diverged', async () => {
    const h = fixture()
    writeSession(h.native, 'original CC context')
    writeSession(h.halo, 'continued in Halo')
    utimesSync(join(h.native, 'session.jsonl'), new Date(1000), new Date(1000))
    expect(await prepareStoredSession({ workDir: h.alias, sessionId: 'session', configDir: h.config, engine: 'anthropic' })).toBe(true)
    expect(readFileSync(join(h.native, 'session.jsonl'), 'utf8')).toBe('continued in Halo')
  })
  it('refuses traversal and reports a genuinely missing transcript', async () => {
    const h = fixture()
    for (const sessionId of ['../outside', 'missing']) expect(await prepareStoredSession({ workDir: h.alias, sessionId, configDir: h.config, engine: 'halo' })).toBe(false)
  })
})
