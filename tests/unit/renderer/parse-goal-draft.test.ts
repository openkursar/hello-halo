/**
 * Composer goal mode: the first lines are the objective, list-style lines are
 * the done-when criteria, and a draft with no objective is not a goal.
 */

import { describe, it, expect } from 'vitest'
import { parseGoalDraft } from '../../../src/renderer/components/goal/parseGoalDraft'

describe('parseGoalDraft', () => {
  it('reads a single line as the objective with no criteria', () => {
    expect(parseGoalDraft('  Migrate the project to TypeScript  ')).toEqual({
      objective: 'Migrate the project to TypeScript',
      doneWhen: [],
    })
  })

  it('turns every list marker into a criterion and strips it', () => {
    const draft = [
      'Ship the release',
      '- Tests pass',
      '* Changelog written',
      '• Tag pushed',
      '1. Notes published',
      '2) Team told',
      '[ ] Docs updated',
      '[] Blog drafted',
    ].join('\n')
    expect(parseGoalDraft(draft)).toEqual({
      objective: 'Ship the release',
      doneWhen: ['Tests pass', 'Changelog written', 'Tag pushed', 'Notes published', 'Team told', 'Docs updated', 'Blog drafted'],
    })
  })

  it('drops the box of a markdown task item', () => {
    expect(parseGoalDraft('Clean up\n- [ ] Remove dead code\n- [x] Rename module')?.doneWhen).toEqual([
      'Remove dead code',
      'Rename module',
    ])
  })

  it('keeps the other lines, in order and with their newlines, as the objective', () => {
    expect(parseGoalDraft('\nFirst part\n- a criterion\nsecond part\n\n')).toEqual({
      objective: 'First part\nsecond part',
      doneWhen: ['a criterion'],
    })
  })

  it('ignores empty criteria and markers without a following space', () => {
    expect(parseGoalDraft('Goal\n- \n-not a marker\n1.5 liters')).toEqual({
      objective: 'Goal\n-not a marker\n1.5 liters',
      doneWhen: [],
    })
  })

  it('handles Windows line endings', () => {
    expect(parseGoalDraft('Goal\r\n- one\r\n- two')).toEqual({ objective: 'Goal', doneWhen: ['one', 'two'] })
  })

  it('returns null when there is no objective', () => {
    expect(parseGoalDraft('')).toBeNull()
    expect(parseGoalDraft('   \n  ')).toBeNull()
    expect(parseGoalDraft('- only a criterion\n- another')).toBeNull()
  })
})
