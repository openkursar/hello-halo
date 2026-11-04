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

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ getActiveEngine: () => 'anthropic', getDefaultEngine: () => 'anthropic' }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: () => '/Applications/Halo.app/Contents/Frameworks/Halo Helper.app/Contents/MacOS/Halo Helper',
}))
vi.mock('../../../../src/main/services/agent/codex/transport/connection', () => ({ resolveBundledCodexBinary: () => null }))
vi.mock('../../../../src/main/services/agent', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/main/services/agent/local-connection')>(
    '../../../../src/main/services/agent/local-connection'
  )
  const engineErrors = await vi.importActual<typeof import('../../../../src/main/services/agent/engine-error')>(
    '../../../../src/main/services/agent/engine-error'
  )
  return { isRefusedLocalConnection: actual.isRefusedLocalConnection, explainEngineError: actual.explainEngineError, isEngineSetupError: engineErrors.isEngineSetupError }
})

import { imErrorReply, imTurnReply } from '../../../../src/main/apps/runtime/im-error-reply'
import { WorkingDirectoryChangedError, WorkingDirectoryUnavailableError } from '../../../../src/main/services/agent/working-dir'
import { AppChatTurnInterrupted, withTurnEndingNote } from '../../../../src/main/apps/runtime/turn-ending'
import { explainEngineError } from '../../../../src/main/services/agent'
import { EngineSourceCompatibilityError } from '../../../../src/shared/engine-source'

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

  it('tells the person asking only to try later when the engine or account cannot run here', () => {
    const missing = Object.assign(new Error('Engine "anthropic" is unavailable: The runtime is not installed'), { name: 'EngineUnavailableError', engineId: 'anthropic' })
    expect(imErrorReply(missing)).toBe('⚠️ 暂时无法回复，请稍后再试。')
    expect(imErrorReply(new EngineSourceCompatibilityError('halo', 'delegated-requires-cc', 'This account requires Claude Code.'))).toBe('⚠️ 暂时无法回复，请稍后再试。')
  })
})

describe('a reply whose turn ended short', () => {
  const failed = (error: string) => ({ kind: 'failed' as const, error })

  it('a request that failed after some text: the text, then the error the chat gets when nothing was written', () => {
    const reason = "Anthropic API error (403): OAuth authentication is currently not allowed for this organization. log at '/Users/lin/space/run.log'"
    expect(imTurnReply('First half of the answer.\n', failed(reason)))
      .toBe(`First half of the answer.\n\n${imErrorReply(new Error(reason))}`)
    expect(imTurnReply('First half of the answer.', failed(reason))).not.toContain('/Users')
  })

  it('a request that failed before any text: the error alone', () => {
    expect(imTurnReply(' \n', failed('API Error: 529 overloaded'))).toBe('⚠️ Error: API Error: 529 overloaded')
  })

  it('a refused local connection after some text reads as it does alone, with no program named', () => {
    const told = imTurnReply('Partial', failed('API Error: Unable to connect to API (EACCES)'))
    expect(told).toBe(`Partial\n\n${imErrorReply(new Error('API Error: Unable to connect to API (EACCES)'))}`)
    expect(told).toContain('安全软件拦截了本机连接')
  })

  it('the step limit and a cut-off turn keep their own notes', () => {
    expect(imTurnReply('Partial', { kind: 'interrupted' })).toBe(withTurnEndingNote('Partial', { kind: 'interrupted' }))
    expect(imTurnReply('Partial', { kind: 'max_turns', limit: 3 })).toBe(withTurnEndingNote('Partial', { kind: 'max_turns', limit: 3 }))
  })

  it('a failure the engine told only as reply text says its reason once', () => {
    const reason = 'stream disconnected before completion'
    expect(imTurnReply(reason, failed(reason))).toBe(`⚠️ Error: ${reason}`)
    expect(imTurnReply(' Codex turn failed\n', failed('Codex turn failed '))).toBe('⚠️ Error: Codex turn failed')
    const afterAnswer = imTurnReply(`First half of the answer.\n\n${reason}`, failed(reason))
    expect(afterAnswer).toBe(`First half of the answer.\n\n⚠️ Error: ${reason}`)
    expect(afterAnswer.split(reason)).toHaveLength(2)
  })

  it('an answer that only mentions the reason keeps all its text', () => {
    const answer = 'The upstream said 529 overloaded, so here is what I had so far.'
    expect(imTurnReply(answer, failed('529 overloaded'))).toBe(`${answer}\n\n⚠️ Error: 529 overloaded`)
    expect(imTurnReply('Retried: 529 overloaded', failed('529 overloaded'))).toBe('Retried: 529 overloaded\n\n⚠️ Error: 529 overloaded')
  })
})
