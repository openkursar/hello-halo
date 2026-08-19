/**
 * Cross-turn team liveness detection.
 *
 * hasActiveTeamTasks guards session rebuilds, idle cleanup, and stop
 * classification. The consumer feeds it team lifecycle thoughts accumulated
 * across turns (isTeamLifecycleThought filter), because the Agent(team_name)
 * spawn usually happens turns before the rebuild trigger fires — evaluating
 * only the last turn's thoughts let rebuilds slip through and kill the team.
 */

import { describe, expect, it } from 'vitest'
import {
  hasActiveTeamTasks,
  isTeamLifecycleThought
} from '../../../../src/main/services/agent/subagent-handler'
import type { Thought } from '../../../../src/main/services/agent/types'

let seq = 0
function thought(partial: Partial<Thought>): Thought {
  return {
    id: `t-${++seq}`,
    type: 'tool_use',
    content: '',
    timestamp: new Date().toISOString(),
    ...partial
  }
}

const teamSpawn = (): Thought =>
  thought({ toolName: 'Agent', toolInput: { team_name: 'code-review-team', name: 'reviewer' } })

const teamDeleteSuccess = (): Thought =>
  thought({
    toolName: 'TeamDelete',
    toolResult: {
      output: JSON.stringify([{ type: 'text', text: JSON.stringify({ success: true }) }]),
      isError: false,
      timestamp: new Date().toISOString()
    }
  })

describe('isTeamLifecycleThought', () => {
  it('matches team spawns and TeamDelete, nothing else', () => {
    expect(isTeamLifecycleThought(teamSpawn())).toBe(true)
    expect(isTeamLifecycleThought(teamDeleteSuccess())).toBe(true)
    // Plain subagent without a team is not team lifecycle
    expect(isTeamLifecycleThought(thought({ toolName: 'Agent', toolInput: { prompt: 'x' } }))).toBe(false)
    expect(isTeamLifecycleThought(thought({ toolName: 'Bash', toolInput: { command: 'ls' } }))).toBe(false)
    expect(isTeamLifecycleThought(thought({ type: 'text', content: 'hi' }))).toBe(false)
  })
})

describe('cross-turn accumulation semantics', () => {
  // Mirrors the consumer's per-turn update:
  //   carried = [...previous, ...turnThoughts.filter(isTeamLifecycleThought)]
  //   next = hasActiveTeamTasks(carried) ? carried : []
  function accumulate(previous: Thought[], turnThoughts: Thought[]): Thought[] {
    const merged = [...previous, ...turnThoughts.filter(isTeamLifecycleThought)]
    return hasActiveTeamTasks(merged) ? merged : []
  }

  it('keeps the team alive across later turns that contain no team thoughts', () => {
    // Turn 1: lead spawns the team
    let carried = accumulate([], [teamSpawn(), teamSpawn(), teamSpawn()])
    expect(hasActiveTeamTasks(carried)).toBe(true)

    // Turn 2..n: ordinary turns (lead reports status, uses other tools)
    carried = accumulate(carried, [thought({ toolName: 'Read', toolInput: { file_path: '/x' } })])
    carried = accumulate(carried, [])
    expect(hasActiveTeamTasks(carried)).toBe(true)
  })

  it('resets after TeamDelete succeeds so a later team starts clean', () => {
    let carried = accumulate([], [teamSpawn()])
    carried = accumulate(carried, [teamDeleteSuccess()])
    expect(carried).toEqual([])

    // A second team spawned later must be considered active again —
    // a stale TeamDelete from the first team must not mask it.
    carried = accumulate(carried, [teamSpawn()])
    expect(hasActiveTeamTasks(carried)).toBe(true)
  })

  it('stays empty for sessions that never spawn a team', () => {
    let carried = accumulate([], [thought({ toolName: 'Bash', toolInput: { command: 'ls' } })])
    expect(carried).toEqual([])
    carried = accumulate(carried, [thought({ toolName: 'Agent', toolInput: { prompt: 'plain subagent' } })])
    expect(carried).toEqual([])
  })
})
