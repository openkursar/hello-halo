import { describe, expect, it } from 'vitest'
import { buildLeadSystemPrompt } from '../../../../src/main/apps/team/lead'

describe('team lead delivery guidance', () => {
  it('coordinates through live arrivals and distinguishes notices from task completion', () => {
    const prompt = buildLeadSystemPrompt({ teamName: 'Review', goal: 'Verify all findings' })
    expect(prompt).toContain('arrive after your current tool call')
    expect(prompt).toContain('Do not poll the board or end a turn just to receive messages')
    expect(prompt).toContain('An execution-ending notice is not a substitute')
    expect(prompt).toContain('does not prove the task')
    expect(prompt).not.toContain('There is no way to wait')
    expect(prompt).not.toContain('as a fresh turn of yours')
    expect(prompt).toContain('team_complete')
  })
})
