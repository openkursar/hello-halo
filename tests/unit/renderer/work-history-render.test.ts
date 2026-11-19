/**
 * How a reply's work reads on screen: folded to one line above the answer,
 * opened to a timeline of what was said with each stretch of operations as one
 * line, the task plan after it, and the words being written always below.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const interpolate = (key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name]))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: interpolate }), getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ holdOpenThoughts: () => () => {} }))
vi.mock('../../../src/renderer/components/references', () => ({ useFileLinkOptions: () => ({ spaceId: 's', baseDir: '/repo' }) }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, mode }: { content: string; mode?: string }) => createElement('p', { 'data-mode': mode ?? 'static' }, content),
}))
vi.mock('../../../src/renderer/components/chat/ArrivalCard', () => ({ ArrivalCard: ({ message }: { message: { content: string } }) => createElement('aside', null, message.content), arrivalIcon: () => () => null }))
vi.mock('../../../src/renderer/components/chat/team-collab', () => ({ readTeamProvenance: () => null }))
vi.mock('../../../src/renderer/components/chat/tool-result', () => ({ ToolResultViewer: ({ output }: { output: string }) => createElement('output', null, output) }))
vi.mock('../../../src/renderer/components/chat/NestedToolTimeline', () => ({ NestedToolTimeline: () => null }))
vi.mock('../../../src/renderer/components/tool/TodoCard', () => ({
  TodoCard: ({ todos, isAgentActive }: { todos: unknown[]; isAgentActive: boolean }) => createElement('section', { 'data-plan': todos.length, 'data-active': isAgentActive }),
}))
vi.mock('../../../src/renderer/components/chat/StreamingBubble', () => ({
  StreamingBubble: ({ content }: { content: string }) => content ? createElement('div', { 'data-bubble': true }, content) : null,
}))
vi.mock('../../../src/renderer/components/tool/BrowserTaskCard', () => ({ BrowserTaskCard: () => null }))
vi.mock('../../../src/renderer/components/tool/TerminalTaskCard', () => ({ TerminalTaskCard: () => null }))
vi.mock('../../../src/renderer/components/chat/AskUserQuestionCard', () => ({ AskUserQuestionCard: () => null }))
vi.mock('../../../src/renderer/components/chat/QueuedMessagesPanel', () => ({ QueuedMessagesPanel: () => null }))
vi.mock('../../../src/renderer/components/chat/ApiRetryNotice', () => ({ ApiRetryNotice: () => null }))
vi.mock('../../../src/renderer/components/chat/MessageRow', () => ({ MessageRow: () => null }))
vi.mock('../../../src/renderer/components/chat/InjectionAnnotation', () => ({ InjectionAnnotation: () => null }))

import { WorkHistory } from '../../../src/renderer/components/chat/work-history/WorkHistory'
import { CollapsedThoughtProcess, LazyCollapsedThoughtProcess } from '../../../src/renderer/components/chat/CollapsedThoughtProcess'
import { ThoughtProcess } from '../../../src/renderer/components/chat/ThoughtProcess'
import { StreamingSection } from '../../../src/renderer/components/chat/StreamingSection'
import { nextThoughtPanelModel } from '../../../src/renderer/components/chat/thought-utils'
import { parseTodoInput } from '../../../src/renderer/utils/thought-activity'
import type { Thought } from '../../../src/renderer/types'

let seq = 0
const at = (second: number) => new Date(Date.UTC(2026, 10, 19, 9, 0, 0) + second * 1000).toISOString()
const say = (content: string, second: number): Thought => ({ id: `say-${++seq}`, type: 'text', content, timestamp: at(second) })
const think = (content: string, second: number): Thought => ({ id: `think-${++seq}`, type: 'thinking', content, timestamp: at(second) })
const tool = (toolName: string, input: Record<string, unknown>, second: number, output: string | null = 'ok'): Thought => ({
  id: `tool-${++seq}`, type: 'tool_use', toolName, toolInput: input, content: '', timestamp: at(second),
  ...(output === null ? {} : { toolResult: { output, isError: false, timestamp: at(second) } }),
})
const plan = (second: number, done: number): Thought => tool('TodoWrite', {
  todos: ['Check scope', 'Run checks', 'Verify hand-off'].map((content, index) => ({
    content, activeForm: `Doing: ${content}`, status: index < done ? 'completed' : index === done ? 'in_progress' : 'pending',
  })),
}, second)

const reply = [
  say('I will check the edges first.', 0),
  tool('Bash', { command: 'npm run test:architecture' }, 10),
  plan(20, 1),
  say('Edges pass. Now the hand-off.', 60),
  ...['a', 'b', 'c', 'd', 'e'].map((name, i) => tool('Read', { file_path: `/repo/src/${name}.ts` }, 70 + i)),
  tool('Grep', { pattern: 'takeQueued' }, 80),
  say('Found a gap.', 1980),
]
const answer = 'Found a gap.'

function work(thoughts: Thought[], props: Partial<Parameters<typeof WorkHistory>[0]> = {}) {
  const model = nextThoughtPanelModel(null, thoughts)
  const latest = model.latestTodo?.toolInput
  return renderToStaticMarkup(createElement(WorkHistory, {
    model, todos: latest ? parseTodoInput(latest) : null, live: false, open: false, onToggle: () => {}, ...props,
  }))
}

describe('work history', () => {
  it('folds a finished reply’s work to one line with how long it took', () => {
    const html = work(reply, { answer })
    expect(html).toContain('Work process')
    expect(html).toContain('· 33 min')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Edges pass.')
    expect(html).not.toContain('data-plan')
  })

  it('opens to what was said with each stretch of work as one line between, then the plan', () => {
    const html = work(reply, { answer, open: true })
    const said = html.indexOf('I will check the edges first.')
    const command = html.indexOf('npm run test:architecture')
    const next = html.indexOf('Edges pass. Now the hand-off.')
    const stretch = html.indexOf('Read 5 files and searched 1 times')
    expect(said).toBeGreaterThan(-1)
    expect(said).toBeLessThan(command)
    expect(command).toBeLessThan(next)
    expect(next).toBeLessThan(stretch)
    expect(html.indexOf('data-plan="3"')).toBeGreaterThan(stretch)
    // The stretch is one line until opened; its steps are not drawn yet.
    expect(html).not.toContain('src/a.ts')
    expect(html).not.toContain('operation details')
    expect(html).not.toContain('TodoWrite')
    // The answer shows below the work, never inside it.
    expect(html).not.toContain(answer)
  })

  it('draws a stretch with one operation as that operation’s own line, beside its reasoning', () => {
    const html = work([say('Checking.', 1), think('Look at the edges.', 2), tool('Bash', { command: 'npm test' }, 3)], { open: true })
    expect(html).toContain('aria-label="Command · npm test"')
    expect(html).toContain('Look at the edges.')
    expect(html).not.toContain('Ran 1 command')
  })

  it('opens with the session notice, which model answered, as a quiet line with nothing to open', () => {
    const notice: Thought = { id: 'sys', type: 'system', content: 'Connected | Model: GLM-5.3-Flash', timestamp: at(0) }
    const html = work([notice, say('Checking.', 1), tool('Bash', { command: 'ls' }, 2), tool('Grep', { pattern: 'x' }, 3)], { open: true })
    const line = html.indexOf('Connected | Model: GLM-5.3-Flash')
    expect(line).toBeGreaterThan(-1)
    expect(line).toBeLessThan(html.indexOf('Checking.'))
    expect(html.slice(html.lastIndexOf('<div', line), line)).not.toContain('button')
  })

  it('opens every stretch at once where the whole trace is the point', () => {
    const html = work(reply, { answer, open: true, showOperations: true })
    expect(html).toContain('src/a.ts')
    expect(html).toContain('takeQueued')
  })

  it('shows no entry for a short reply with nothing but its answer', () => {
    const notice: Thought = { id: 'sys', type: 'system', content: 'Connected | Model: m', timestamp: at(0) }
    const html = renderToStaticMarkup(createElement(CollapsedThoughtProcess, { thoughts: [notice, say('Friday at three.', 1)], answer: 'Friday at three.' }))
    expect(html).toBe('')
  })

  it('offers the saved work of a reply whose only step besides its answer was a compaction', () => {
    const lazy = (summary: Record<string, unknown>) => renderToStaticMarkup(createElement(LazyCollapsedThoughtProcess, {
      thoughtsSummary: { count: 2, types: { system: 2 }, ...summary }, answer: 'Done.', onLoadThoughts: async () => [],
    }))
    expect(lazy({ compactions: 1 })).toContain('Work process')
    // The model notice alone is still nothing to open.
    expect(lazy({ count: 1, types: { system: 1 } })).toBe('')
  })

  it('calls a reply with only its reasoning work, not thinking', () => {
    const html = work([think('The person says thanks.', 0), say('You are welcome.', 4)], { answer: 'You are welcome.' })
    expect(html).toContain('Work process')
    expect(html).not.toMatch(/[Tt]hought|Thinking/)
  })

  it('marks where the context was compacted, as a line of its own', () => {
    const compaction: Thought = { id: 'c', type: 'system', content: 'Context compacted', compaction: { trigger: 'auto' }, timestamp: at(5) }
    const html = work([tool('Bash', { command: 'ls' }, 1), compaction, tool('Bash', { command: 'pwd' }, 9)], { open: true })
    expect(html).toContain('Context compacted automatically')
    expect(html.indexOf('ls')).toBeLessThan(html.indexOf('Context compacted automatically'))
  })
})

describe('errors a tool reported', () => {
  const steps = [say('Searching.', 0), tool('Grep', { pattern: 'x' }, 1, 'rg: permission denied'), tool('Bash', { command: 'ls' }, 2)]
  steps[1] = { ...steps[1], toolResult: { output: 'rg: permission denied', isError: true, timestamp: at(1) } }

  it('are not called a failure anywhere in the work', () => {
    const html = work(steps, { open: true, showOperations: true })
    expect(html).not.toMatch(/not successful|No result/i)
    expect(html).toContain('Searched 1 times and ran 1 commands')
  })

  it('only tint that tool’s own icon', () => {
    const html = work(steps, { open: true, showOperations: true })
    const line = html.slice(html.indexOf('aria-label="Search'), html.indexOf('aria-label="Command'))
    expect(line).toContain('text-halo-warning/75')
    expect(html.match(/text-halo-warning/g)).toHaveLength(1)
  })
})

describe('step icons', () => {
  it('show what a team, browser, terminal or skill tool is, not a generic tool mark', () => {
    const steps = [
      say('Bringing in help.', 0),
      tool('mcp__halo-team__spawn_agent', { name: 'reviewer' }, 1), tool('mcp__halo-team__team_send', { to: 'reviewer' }, 2),
      tool('mcp__halo-team__team_read_board', {}, 3), tool('mcp__ai-browser__browser_navigate', { url: 'https://example.org' }, 4),
      tool('mcp__ai-terminal__terminal_write', {}, 5), tool('Skill', { skill: 'pdf' }, 6), tool('mcp__x__lookup', {}, 7),
    ]
    const html = work(steps, { open: true, showOperations: true })
    for (const icon of ['lucide-user-plus', 'lucide-send', 'lucide-users', 'lucide-globe', 'lucide-square-terminal', 'lucide-puzzle']) expect(html).toContain(icon)
    // A stretch led by starting a collaborator shows that, and only an unknown tool keeps the generic mark.
    const line = html.slice(html.indexOf('aria-label="Started 1 collaborators'), html.indexOf('</button>', html.indexOf('aria-label="Started 1 collaborators')))
    expect(line).toContain('lucide-user-plus')
    expect(html.match(/lucide-braces/g)).toHaveLength(1)
  })
})

describe('step titles', () => {
  it('end at a fixed length, and show the whole command only when opened and cut short', () => {
    const long = 'echo "=== check targets before removing"; /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString"'
    const html = work([say('Checking.', 0), tool('Bash', { command: long }, 1)], { open: true })
    expect(html).toContain('>echo &quot;=== check targets before removing&quot;; /u…<')
    expect(html).toContain(`aria-label="Command · ${long.replace(/"/g, '&quot;')}"`)
  })

  it('read reasoning as one line of its opening words, not only its first line', () => {
    const html = work([say('Cleaning.', 0), think('Cleanup done so far:\n- Checked the support folder\n- Removed caches', 1)], { open: true })
    expect(html).toContain('>Cleanup done so far: - Checked the support f…<')
  })
})

describe('work while the reply runs', () => {
  const running = [say('I will check the edges first.', 0), plan(5, 1), tool('Bash', { command: 'npm test' }, 9, null)]

  it('folded, names the task in progress with the plan’s progress', () => {
    const html = renderToStaticMarkup(createElement(ThoughtProcess, { thoughts: running, isThinking: true }))
    expect(html).toContain('Doing: Run checks')
    expect(html).toContain('Tasks 1/3')
    expect(html).toContain('animate-spin')
    expect(html).not.toContain('Work process')
  })

  it('says it is working, or replying, rather than thinking', () => {
    const steps = [think('Let me look.', 0)]
    expect(renderToStaticMarkup(createElement(ThoughtProcess, { thoughts: steps, isThinking: true }))).toContain('Working...')
    expect(renderToStaticMarkup(createElement(ThoughtProcess, { thoughts: steps, isThinking: true, writing: true }))).toContain('Replying...')
  })

  it('keeps the answer being written below the work, in the reply’s own bubble', () => {
    const thoughts = [think('Plan the answer.', 0), tool('Bash', { command: 'ls' }, 1), tool('Grep', { pattern: 'x' }, 2)]
    const html = renderToStaticMarkup(createElement(StreamingSection, {
      streamingContent: '# The answer', isStreaming: true, thoughts, isThinking: true, textBlockVersion: 0,
    }))
    expect(html).toContain('<div data-bubble="true"># The answer</div>')
    expect(html).toContain('Replying...')
  })

  it('leaves the words the bubble shows out of the work, once', () => {
    const latest = say('Now the hand-off.', 5)
    const steps = [say('Edges first.', 0), tool('Bash', { command: 'ls' }, 1), latest, tool('Bash', { command: 'npm test' }, 9, null)]
    const html = work(steps, { live: true, open: true, liveTextIds: new Set([latest.id]) })
    expect(html).toContain('Edges first.')
    expect(html).not.toContain('Now the hand-off.')
  })

  it('marks a step in progress by color only, and only while the reply runs', () => {
    const steps = [say('Running the checks.', 0), tool('Bash', { command: 'npm test' }, 1, null)]
    const live = work(steps, { live: true, open: true })
    expect(live).toContain('aria-label="Command · npm test · Running"')
    expect(live).toContain('text-primary')
    expect(live).not.toMatch(/>Running</)
    const saved = work(steps, { open: true })
    expect(saved).toContain('aria-label="Command · npm test"')
    expect(saved).not.toContain('No result')
  })

  it('spins only in the header: a running stretch keeps its tool icon and names the step in color', () => {
    const steps = [say('Checking.', 0), tool('Bash', { command: 'ls' }, 1), tool('Bash', { command: 'ping -c 1 example.org' }, 2, null)]
    const html = work(steps, { live: true, open: true, activity: 'Working on it' })
    expect(html.match(/animate-spin/g)).toHaveLength(1)
    expect(html).toContain('Ran 2 commands')
  })

  it('draws a finished step the same while running and after the reply ends', () => {
    const steps = [say('Running the checks.', 0), tool('Bash', { command: 'npm test' }, 1)]
    const line = (html: string) => html.slice(html.indexOf('npm test') - 400, html.indexOf('npm test') + 200)
    expect(line(work(steps, { live: true, open: true }))).toBe(line(work(steps, { open: true })))
  })
})
