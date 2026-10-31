import { describe, it, expect } from 'vitest'
import { opensWithSlashCommand } from '../../../../src/main/services/agent/opening-context'

describe('opensWithSlashCommand', () => {
  it.each(['/skill', '/skill sample-input', '  /skill args', '/plugin:skill args', '/skill\nsecond line', '/v2.review'])(
    'recognises %j', text => expect(opensWithSlashCommand(text)).toBe(true))

  it.each(['', 'plain text', '/etc/hosts is wrong', '//comment', '/', '/ spaced', 'see /skill later', '<memory>x</memory>/skill', '/tmp is full', '/Users', '/var\nlogs'])(
    'does not treat %j as a command', text => expect(opensWithSlashCommand(text)).toBe(false))
})
