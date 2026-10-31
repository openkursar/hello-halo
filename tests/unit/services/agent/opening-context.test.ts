import { describe, it, expect } from 'vitest'
import { opensWithSlashCommand, withOpeningContext } from '../../../../src/main/services/agent/opening-context'

describe('opensWithSlashCommand', () => {
  it.each(['/skill', '/skill sample-input', '  /skill args', '/plugin:skill args', '/skill\nsecond line', '/v2.review'])(
    'recognises %j', text => expect(opensWithSlashCommand(text)).toBe(true))

  it.each(['', 'plain text', '/etc/hosts is wrong', '//comment', '/', '/ spaced', 'see /skill later', '<memory>x</memory>/skill'])(
    'does not treat %j as a command', text => expect(opensWithSlashCommand(text)).toBe(false))
})

describe('withOpeningContext', () => {
  it('places the opening context ahead of an ordinary message', () => {
    expect(withOpeningContext('<memory/>\n\n', 'hello')).toBe('<memory/>\n\nhello')
  })

  it('leaves a leading slash command first so the engine can route it', () => {
    expect(withOpeningContext('<memory/>\n\n', '/skill input')).toBe('/skill input')
  })

  it('keeps the context ahead of a path-like first token', () => {
    expect(withOpeningContext('<memory/>\n\n', '/etc/hosts is wrong')).toBe('<memory/>\n\n/etc/hosts is wrong')
  })

  it('adds nothing when there is no opening context', () => {
    expect(withOpeningContext('', '/skill input')).toBe('/skill input')
    expect(withOpeningContext('', 'hello')).toBe('hello')
  })

  it('does not hide a command that already follows other turn context', () => {
    const contextual = '<halo_canvas>open</halo_canvas>\n\n/skill input'
    expect(withOpeningContext('<memory/>\n\n', contextual)).toBe('<memory/>\n\n' + contextual)
  })
})
