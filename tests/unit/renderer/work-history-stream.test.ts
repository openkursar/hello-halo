/**
 * The order a reply's work reads in: what the AI said along the way, and
 * between those each stretch of operations as one group, summed up in one
 * line. Notable steps keep lines of their own, and each sentence is shown
 * once — as the answer, or as the words the reply is still writing.
 */

import { describe, expect, it } from 'vitest'
import { hasWorkToShow, nextWorkStream } from '../../../src/renderer/components/chat/work-history/work-stream'
import { answerTextIds, liveTextIds, sameIdsOr } from '../../../src/renderer/components/chat/work-history/spoken-text'
import { summarizeGroup } from '../../../src/renderer/components/chat/work-history/group-summary'
import { describeOperation, editStats } from '../../../src/renderer/components/chat/work-history/operation-label'
import { formatWorkDuration } from '../../../src/renderer/components/chat/work-history/duration'
import { toArrivalThought } from '../../../src/renderer/components/chat/transcript'
import type { Message, Thought } from '../../../src/renderer/types'

let seq = 0
const at = () => new Date(Date.UTC(2026, 10, 19, 9, 0, ++seq)).toISOString()
const say = (content: string): Thought => ({ id: `say-${++seq}`, type: 'text', content, timestamp: at() })
const think = (content: string): Thought => ({ id: `think-${++seq}`, type: 'thinking', content, timestamp: at() })
const tool = (toolName: string, input: Record<string, unknown> = {}, result: { output?: string; isError?: boolean } | null = { output: 'ok' }): Thought => ({
  id: `tool-${++seq}`, type: 'tool_use', toolName, toolInput: input, content: '', timestamp: at(),
  ...(result ? { toolResult: { output: result.output ?? 'ok', isError: !!result.isError, timestamp: at() } } : {}),
})
const reads = (count: number) => Array.from({ length: count }, (_, i) => tool('Read', { file_path: `/repo/src/f${i}.ts` }))
const NONE: ReadonlySet<string> = new Set()

function shape(steps: Thought[], shownBelow: ReadonlySet<string> = NONE, live = false) {
  return nextWorkStream(null, steps, shownBelow, live).entries.map(entry => {
    switch (entry.kind) {
      case 'group': return `group:${entry.steps.map(step => step.toolName ?? step.type).join(',')}`
      case 'speech': return `say:${entry.thought.content}`
      case 'arrivals': return `arrivals:${entry.thoughts.length}`
      case 'step': return `step:${entry.thought.toolName ?? entry.thought.type}`
    }
  })
}

const t = (key: string, options?: Record<string, unknown>) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name]))

describe('work timeline', () => {
  it('keeps what was said, with each stretch of operations between as one group', () => {
    const steps = [say('Checking the edges first.'), think('plan'), tool('Bash'), tool('Grep'), say('Now the hand-off.'), ...reads(3), say('Found it.')]
    const answer = answerTextIds(steps, 'Found it.')
    expect(shape(steps, answer)).toEqual(['say:Checking the edges first.', 'group:thinking,Bash,Grep', 'say:Now the hand-off.', 'group:Read,Read,Read'])
  })

  it('keeps a long stretch with nothing said as one group, however long', () => {
    expect(shape([...reads(300), tool('Bash')])).toEqual([`group:${[...Array(300).fill('Read'), 'Bash'].join(',')}`])
  })

  it('gives the session notice, compactions, sub-agent tasks and engine errors lines of their own', () => {
    const notice: Thought = { id: 'sys', type: 'system', content: 'Connected | Model: m', timestamp: at() }
    const compaction: Thought = { id: 'compact', type: 'system', content: 'Context compacted', compaction: { trigger: 'auto' }, timestamp: at() }
    const error: Thought = { id: 'err', type: 'error', content: 'Provider refused', timestamp: at() }
    const steps = [notice, tool('Bash'), compaction, tool('Read'), tool('Task', { description: 'Review' }), tool('Bash'), error]
    expect(shape(steps)).toEqual(['step:system', 'group:Bash', 'step:system', 'group:Read', 'step:Task', 'group:Bash', 'step:error'])
  })

  it('keeps the session notice as the first line, as the work always read', () => {
    const notice: Thought = { id: 'sys', type: 'system', content: 'Connected | Model: m', timestamp: at() }
    expect(shape([notice, say('First.'), tool('Bash')])).toEqual(['step:system', 'say:First.', 'group:Bash'])
  })

  it('puts records received in a row together, and between groups', () => {
    const arrival = (content: string) => toArrivalThought({ id: content, role: 'system', source: 'team-message', content, timestamp: at() } as Message)
    expect(shape([tool('Bash'), arrival('a'), arrival('b'), tool('Bash')])).toEqual(['group:Bash', 'arrivals:2', 'group:Bash'])
  })

  it('leaves out reasoning that says nothing once the reply is saved', () => {
    const empty = { ...think(''), isStreaming: true }
    expect(shape([empty, tool('Bash')])).toEqual(['group:Bash'])
    expect(shape([empty, tool('Bash', {}, null)], NONE, true)).toEqual(['group:thinking,Bash'])
  })

  it('keeps a group unchanged while only later steps change, so its line is not drawn again', () => {
    const first = [say('Start.'), tool('Bash'), tool('Grep'), say('Next.'), tool('Read', {}, null)]
    const before = nextWorkStream(null, first, NONE, true)
    const finished = { ...first[4], toolResult: { output: 'done', isError: false, timestamp: at() } }
    const after = nextWorkStream(before, [...first.slice(0, 4), finished, tool('Read')], NONE, true)
    expect(after.entries[1]).toBe(before.entries[1])
    expect(after.entries[3]).not.toBe(before.entries[3])
  })
})

describe('group summary', () => {
  it('counts kinds in the order they first came, not reasoning or notices', () => {
    const summary = summarizeGroup([think('x'), tool('Bash'), tool('Grep'), tool('Bash'), tool('Read', { file_path: '/a/shot.png' }), tool('Read', { file_path: '/a/b.ts' })], false)
    expect(summary.parts.map(part => t(part.key, { count: part.count }))).toEqual(['Ran 2 commands', 'Searched 1 times', 'Viewed 1 images', 'Read 1 files'])
    expect(summary.counted).toBe(5)
  })

  it('names collaborators, messages, the browser and the terminal by what they are', () => {
    const summary = summarizeGroup([
      tool('mcp__halo-team__spawn_agent', { name: 'reviewer' }), tool('mcp__halo-team__team_send', { to: 'reviewer' }),
      tool('mcp__ai-browser__browser_navigate', { url: 'https://example.org' }), tool('mcp__ai-terminal__terminal_write'), tool('mcp__x__lookup'),
    ], false)
    expect(summary.parts.map(part => part.key)).toEqual([
      'Started {{count}} collaborators', 'Sent {{count}} messages', 'Used the browser {{count}} times', 'Used the terminal {{count}} times', 'Used tools {{count}} times',
    ])
  })

  it('names only an operation as still running: reasoning in progress is what the header already says', () => {
    const reasoning = { ...think('weighing options'), isStreaming: true }
    expect(summarizeGroup([tool('Bash'), tool('Grep'), reasoning], true).running).toBeUndefined()
  })

  it('names the step still running only while the reply runs, and never counts errors a tool reported', () => {
    const running = tool('Bash', { command: 'npm test' }, null)
    const steps = [tool('Bash', {}, { output: 'no', isError: true }), running]
    const live = summarizeGroup(steps, true)
    expect(live.running).toBe(running)
    expect(live).not.toHaveProperty('failed')
    expect(summarizeGroup(steps, false).running).toBeUndefined()
  })
})

describe('each sentence is shown once', () => {
  it('takes the text steps that make up the saved answer out of the work', () => {
    const intro = say('Let me look.')
    const first = say('The bug is in the hand-off.')
    const second = say('Add a test first.')
    const ids = answerTextIds([intro, tool('Read'), first, tool('TodoWrite'), second], 'The bug is in the hand-off.\n\nAdd a test first.')
    expect([...ids].sort()).toEqual([first.id, second.id].sort())
  })

  it('matches across whitespace the engine adds when it joins blocks', () => {
    const last = say('  Done:\n- one\n- two  ')
    expect(answerTextIds([last], 'Done:\n\n- one\n- two').has(last.id)).toBe(true)
  })

  it('shows a stopped reply’s last words once, as what it got to', () => {
    const last = say('Verifying the last hand-off now.')
    const steps = [say('Edges pass.'), tool('Bash'), last, tool('Bash', { command: 'npm test' }, null)]
    // Words shown below do not split the work around them into two lines saying the same thing.
    expect(shape(steps, answerTextIds(steps, 'Verifying the last hand-off now.'))).toEqual(['say:Edges pass.', 'group:Bash,Bash'])
  })

  it('leaves the words a running reply still shows below out of its work', () => {
    const latest = say('Now the hand-off.')
    const steps = [say('Edges first.'), tool('Bash'), latest, tool('Bash', {}, null)]
    expect([...liveTextIds(steps, 'Now the hand-off.')]).toEqual([latest.id])
    // Text joined across a plan update is one bubble: both steps are shown below.
    const part = say('Part one.')
    const ids = liveTextIds([part, tool('TodoWrite')], 'Part one.\n\nPart tw')
    expect(ids.has(part.id)).toBe(true)
    // The final answer being written is no step yet: nothing is left out.
    expect(liveTextIds([think('x'), tool('Bash')], '# Answer').size).toBe(0)
  })

  it('leaves out every block the words below joined, however many', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => say(`Part ${i + 1} of the answer.`))
    const steps = [say('Before the tool.'), tool('Bash'), ...blocks]
    const live = `${blocks.map(block => block.content).join('\n\n')}\n\nPart 13 is still being wri`
    const ids = liveTextIds(steps, live)
    expect(ids.size).toBe(12)
    expect(ids.has(steps[0].id)).toBe(false)
    expect(shape(steps, ids, true)).toEqual(['say:Before the tool.', 'group:Bash'])
  })

  it('keeps the same set while it names the same steps, so the work is not redrawn per token', () => {
    const a = new Set(['x'])
    expect(sameIdsOr(a, new Set(['x']))).toBe(a)
    expect(sameIdsOr(a, new Set(['y']))).not.toBe(a)
  })

  it('has nothing to open for a short reply whose only words are its answer', () => {
    const answer = say('Friday at three works.')
    const notice: Thought = { id: 'sys', type: 'system', content: 'Connected', timestamp: at() }
    expect(hasWorkToShow([notice, answer], answerTextIds([notice, answer], 'Friday at three works.'), false)).toBe(false)
    expect(hasWorkToShow([notice, think('The person says thanks.'), answer], answerTextIds([answer], 'Friday at three works.'), false)).toBe(true)
  })
})

describe('operation lines', () => {
  it('names the kind and what it acted on, with paths relative to the space', () => {
    expect(describeOperation(tool('Bash', { command: 'npm test' }))).toMatchObject({ kind: 'Command', translate: true, target: 'npm test', monospace: true })
    expect(describeOperation(tool('Read', { file_path: '/repo/src/a.ts' }), '/repo')).toMatchObject({ kind: 'Read', target: 'src/a.ts' })
    expect(describeOperation(tool('Read', { file_path: '/repo/shot.png' }), '/repo')).toMatchObject({ kind: 'Image', target: 'shot.png' })
    expect(describeOperation(tool('Task', { description: 'Review the plan' }))).toMatchObject({ kind: 'Sub-agent', target: 'Review the plan' })
    expect(describeOperation(tool('mcp__ai-browser__browser_navigate', { url: 'https://www.example.org/docs' }))).toMatchObject({ kind: 'Browser', target: 'navigate · example.org/docs' })
    expect(describeOperation(tool('mcp__halo-team__team_send', { to: 'reviewer', message: 'hi' }))).toMatchObject({ kind: 'Message', target: 'reviewer' })
    expect(describeOperation(tool('mcp__halo-team__team_read_board', {}))).toMatchObject({ kind: 'Team', target: 'read_board' })
    expect(describeOperation(tool('mcp__x__lookup', { q: 'term' }))).toMatchObject({ kind: 'lookup', translate: false })
  })

  it('counts an edit’s lines the way the reply’s file changes do', () => {
    expect(editStats(tool('Write', { file_path: '/a', content: 'a\nb\nc' }))).toEqual({ added: 3, removed: 0 })
    expect(editStats(tool('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }))).toEqual({ added: 1, removed: 1 })
    expect(editStats(tool('Bash'))).toBeUndefined()
  })
})

describe('work duration', () => {
  it('reads in the unit a person would say', () => {
    expect(formatWorkDuration(0.4, t)).toBeUndefined()
    expect(formatWorkDuration(12.3, t)).toBe('12 sec')
    expect(formatWorkDuration(33 * 60 + 10, t)).toBe('33 min')
    expect(formatWorkDuration(2 * 3600 + 5 * 60, t)).toBe('2 h 5 min')
  })
})
