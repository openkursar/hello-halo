import { describe, it, expect } from 'vitest'
import { opensWithSlashCommand } from '../../../../src/main/services/agent/opening-context'

describe('opensWithSlashCommand', () => {
  it.each(['/skill', '/skill sample-input', '  /skill args', '/plugin:skill args', '/skill\nsecond line', '/v2.review', '/周报 本周总结', '/étude', '/_private x', '/a@b', '/a+b arg'])(
    'recognises %j', text => expect(opensWithSlashCommand(text)).toBe(true))

  it.each(['', 'plain text', '/etc/hosts is wrong', '//comment', '/', '/ spaced', 'see /skill later', '<memory>x</memory>/skill', '/tmp is full', '/Users', '/var\nlogs', '/tmp/x', '/C:/Users/me', '/周报/下载'])(
    'does not treat %j as a command', text => expect(opensWithSlashCommand(text)).toBe(false))
})
