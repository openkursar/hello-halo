/**
 * Choosing a command from the slash menu completes the command at the start of
 * the composer. Text the user already has after it is theirs and must stay.
 */

import { describe, expect, it } from 'vitest'
import { completeSlashCommand } from '../../../src/renderer/utils/skill-command'

describe('completing a slash command', () => {
  it('turns a partly typed command into the chosen one followed by a space', () => {
    expect(completeSlashCommand('/rev', '/review')).toBe('/review ')
    expect(completeSlashCommand('/', '/review')).toBe('/review ')
  })

  it('keeps the draft that follows a command inserted by a skill action', () => {
    expect(completeSlashCommand('/probe-skill quarterly evidence notes', '/probe-skill')).toBe('/probe-skill quarterly evidence notes')
  })

  it('replaces only the command token when another command is chosen over a draft', () => {
    expect(completeSlashCommand('/rev quarterly evidence', '/review')).toBe('/review quarterly evidence')
  })

  it('keeps the indentation before the command', () => {
    expect(completeSlashCommand('  /rev', '/review')).toBe('  /review ')
  })

  it('starts from the command when the composer holds no command', () => {
    expect(completeSlashCommand('', '/review')).toBe('/review ')
    expect(completeSlashCommand('plain text', '/review')).toBe('/review ')
  })
})
