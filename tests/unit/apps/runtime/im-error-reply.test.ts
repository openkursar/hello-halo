/**
 * What an IM chat is told when its turn failed (apps/runtime/im-error-reply).
 *
 * An IM group may hold people from outside, so nothing about the computer Halo
 * runs on goes out: a local connection refused by security software is told
 * without the program to allow, and any other error loses this computer's paths
 * before it is cut to length. The explanation of a refused connection is longer
 * than that length, and used to stop mid-sentence before its useful part.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ getActiveEngine: () => 'anthropic' }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: () => '/Applications/Halo.app/Contents/Frameworks/Halo Helper.app/Contents/MacOS/Halo Helper',
}))
vi.mock('../../../../src/main/services/agent/codex/transport/connection', () => ({ resolveBundledCodexBinary: () => null }))
vi.mock('../../../../src/main/services/agent', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/main/services/agent/local-connection')>(
    '../../../../src/main/services/agent/local-connection'
  )
  return { isRefusedLocalConnection: actual.isRefusedLocalConnection, explainEngineError: actual.explainEngineError }
})

import { imErrorReply } from '../../../../src/main/apps/runtime/im-error-reply'
import { WorkingDirectoryChangedError, WorkingDirectoryUnavailableError } from '../../../../src/main/services/agent/working-dir'
import { AppChatTurnInterrupted, withTurnEndingNote } from '../../../../src/main/apps/runtime/turn-ending'
import { explainEngineError } from '../../../../src/main/services/agent'

describe('what an IM chat is told when its turn failed', () => {
  it('a turn cut off before writing anything: that it was, and how to carry on', () => {
    expect(imErrorReply(new AppChatTurnInterrupted())).toBe(withTurnEndingNote('', { kind: 'interrupted' }))
  })

  it('a local connection refused by security software: what happened and who sees to it, never the program', () => {
    const explained = explainEngineError('API Error: Unable to connect to API (EACCES)')
    expect(explained).toContain('/Applications/Halo.app')

    for (const error of [explained, 'fetch failed (EACCES)']) {
      const told = imErrorReply(new Error(error))
      expect(told).toContain('安全软件拦截了本机连接')
      expect(told).toContain('请主人在 Halo 里查看')
      expect(told).not.toContain('/Applications')
      expect(told).not.toContain('Error')
    }
  })

  it('a working folder that is missing, or changed while the message was prepared: what to do, never the folder', () => {
    const missing = imErrorReply(new WorkingDirectoryUnavailableError('/Users/lin/Private Projects/halo', 'space-1'))
    const changed = imErrorReply(new WorkingDirectoryChangedError())

    expect(missing).toBe('⚠️ 这个数字人的工作目录暂时不可用，请主人在 Halo 里处理。')
    expect(changed).toBe('⚠️ 这个数字人的工作目录刚刚更换，请再发一次。')
    for (const told of [missing, changed]) {
      expect(told).not.toContain('/Users')
      expect(told).not.toContain('Error')
    }
  })

  it('any other error: what it says, without this computer\'s paths', () => {
    const told = (message: string) => imErrorReply(new Error(message))

    expect(told("ENOENT: no such file or directory, open '/Users/lin/My Space/notes final.md'"))
      .toBe("⚠️ Error: ENOENT: no such file or directory, open '<local path>'")
    expect(told('spawn C:\\Users\\Lin Wei\\AppData\\Local\\Halo\\engine.exe ENOENT'))
      .toBe('⚠️ Error: spawn <local path> ENOENT')
    expect(told('cwd=/home/lin/space is not a directory')).toBe('⚠️ Error: cwd=<local path> is not a directory')
    expect(told('cannot read \\\\fileserver\\team\\plan.docx')).toBe('⚠️ Error: cannot read <local path>')
    expect(told('opened file:///Volumes/data/lin/x.json')).toBe('⚠️ Error: opened <local path>')
    expect(told('/private/var/folders/x/T/halo-1/out.log is gone')).toBe('⚠️ Error: <local path> is gone')
  })

  it('leaves the paths of web addresses and API routes alone', () => {
    const message = 'API Error: 404 from https://gateway.example.com/Users/v1/messages (route /v1/chat/completions)'
    expect(imErrorReply(new Error(message))).toBe(`⚠️ Error: ${message}`)
  })

  it('cuts a long error to 200 characters after the paths are gone, and says so', () => {
    const told = imErrorReply(new Error(`Failed in /Users/lin/space: ${'x'.repeat(400)}`))

    expect(told.startsWith('⚠️ Error: Failed in <local path>: xxx')).toBe(true)
    expect(told.length).toBe('⚠️ Error: '.length + 200 + 1)
    expect(told.endsWith('…')).toBe(true)
  })

  it('an error with nothing to say', () => {
    expect(imErrorReply(new Error(''))).toBe('⚠️ Error: Unknown error')
    expect(imErrorReply(undefined)).toBe('⚠️ Error: Unknown error')
  })
})
