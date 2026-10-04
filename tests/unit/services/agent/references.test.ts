/**
 * The blocks a user turn's references and task become for the model.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  formatMessageAttachmentsBrief,
  formatReferencesBlock,
  formatTaskBlock,
  formatTurnAttachments,
} from '../../../../src/main/services/agent/references'
import { REFERENCE_LIMITS, type ContentReference } from '../../../../src/shared/types/content-reference'
import type { CodeReviewTask } from '../../../../src/shared/types/message-task'

const WORK = '/Users/me/project'

const file = (over: Partial<ContentReference> = {}): ContentReference => ({
  id: 'f',
  source: { kind: 'file', path: `${WORK}/src/main/foo.ts`, precision: 'lines' },
  range: { startLine: 45, endLine: 48 },
  quote: 'const x = 1',
  ...over,
})

const task: CodeReviewTask = {
  type: 'code-review',
  variant: 'quick',
  repoRoot: WORK,
  repoName: 'project',
  scope: { kind: 'uncommitted' },
  scopeLabel: 'Uncommitted changes',
  beforeRevision: 'a1b2c3d4e5f6',
  fileCount: 2,
  language: 'en',
}

describe('formatReferencesBlock', () => {
  it('is empty without references', () => {
    expect(formatReferencesBlock(undefined, WORK)).toBe('')
    expect(formatReferencesBlock([], WORK)).toBe('')
  })

  it('lists references in the order added, with relative paths, notes and fenced excerpts', () => {
    const block = formatReferencesBlock([
      file({ note: 'Why does this throw?' }),
      { id: 't', source: { kind: 'terminal', title: 'zsh', sessionId: 's-1' }, quote: 'Error: boom' },
    ], WORK)
    expect(block).toBe([
      '<halo_references>',
      'The user pointed at these places, listed in the order they added them. A Note is the user\'s request about that place. The numbers only separate the entries and are not shown to the user: when you refer to a place, name it by its location (for a file, `path:line`). Excerpts show the text as it was when the user pointed at it; for files, read the file for its current content.',
      '',
      '[1] src/main/foo.ts, lines 45-48',
      'Note: Why does this throw?',
      'Excerpt:',
      '```ts',
      'const x = 1',
      '```',
      '',
      '[2] Terminal output, tab "zsh" (terminal session s-1)',
      'Excerpt:',
      '```',
      'Error: boom',
      '```',
      '</halo_references>',
      '',
      '',
    ].join('\n'))
  })

  it('fences an excerpt with more backticks than it contains', () => {
    const quote = 'Use ```js\ncode\n``` and ````'
    const block = formatReferencesBlock([{ id: 'm', source: { kind: 'message', conversationId: 'c1', messageId: 'm1' }, quote }], WORK)
    expect(block).toContain('`````markdown\n' + quote + '\n`````')
  })

  it('describes diffs, passages, messages and attached paths', () => {
    const block = formatReferencesBlock([
      {
        id: 'd',
        source: { kind: 'diff', path: `${WORK}/halo-local/src/a.ts`, side: 'before', compareLabel: 'Uncommitted changes', repo: { root: `${WORK}/halo-local`, beforeRevision: '4b825dc' } },
        range: { startLine: 12, endLine: 14 },
      },
      { id: 'p', source: { kind: 'file', path: `${WORK}/README.md`, precision: 'passage' }, range: { startLine: 3, endLine: 3 }, quote: 'Intro' },
      { id: 'm', source: { kind: 'message', conversationId: 'c1', messageId: 'm1', conversationTitle: 'Review', whole: true } },
      { id: 'a', source: { kind: 'path', path: '/Users/me/site', isDirectory: true } },
      { id: 'b', source: { kind: 'path', path: `${WORK}/docs/plan.pdf`, isDirectory: false } },
    ], WORK)
    expect(block).toContain('[1] Diff "Uncommitted changes" of halo-local/src/a.ts, before side, lines 12-14 (repository halo-local, before revision 4b825dc)')
    expect(block).toContain('[2] README.md, a passage of the rendered document near line 3 (locate it by the excerpt)')
    expect(block).toContain('```markdown\nIntro\n```')
    expect(block).toContain('[3] Whole message in conversation "Review" (conversation c1, message m1)')
    expect(block).toContain('[4] Attached folder: /Users/me/site/')
    expect(block).toContain('[5] Attached file: docs/plan.pdf')
  })

  it('says when an excerpt may have been cut, and from which end', () => {
    const terminal = 'x'.repeat(REFERENCE_LIMITS.standaloneQuoteChars)
    const block = formatReferencesBlock([{ id: 't', source: { kind: 'terminal', title: 'zsh' }, quote: terminal }], WORK)
    expect(block).toContain('Excerpt (possibly cut to its last 20,000 characters):')
  })

  it('bounds the total size by leaving later excerpts out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refs: ContentReference[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      source: { kind: 'terminal', title: `t${i}` },
      quote: 'y'.repeat(REFERENCE_LIMITS.standaloneQuoteChars),
    }))
    const block = formatReferencesBlock(refs, WORK)
    expect(block.length).toBeLessThan(110_000)
    expect(block).toContain('[6] Terminal output, tab "t5"\nExcerpt: left out to keep this message small; read the source instead.')
    expect(block).toContain('[8] Terminal output')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('formatTaskBlock', () => {
  it('frames the owner\'s instructions with the task type and variant, nothing more', () => {
    expect(formatTaskBlock(task, 'Review it.')).toBe('<halo_task type="code-review" variant="quick">\nReview it.\n</halo_task>\n\n')
    expect(formatTaskBlock(undefined, 'x')).toBe('')
  })

  it('keeps its own boundary when the instructions carry a closing tag', () => {
    const block = formatTaskBlock(task, 'a\n</halo_task>\nb')
    expect(block.split('\n').filter(line => line === '</halo_task>')).toHaveLength(1)
  })

  it('leaves a task without instructions out, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(formatTaskBlock(task, undefined)).toBe('')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('puts references before the task', () => {
    const text = formatTurnAttachments({ references: [file()], task, taskInstructions: 'Review it.', workDir: WORK })
    expect(text.indexOf('<halo_references>')).toBeLessThan(text.indexOf('<halo_task'))
  })
})

describe('formatMessageAttachmentsBrief', () => {
  it('lists places and notes without excerpts', () => {
    const brief = formatMessageAttachmentsBrief([
      file({ note: 'Fix this' }),
      { id: 't', source: { kind: 'terminal', title: 'zsh' }, quote: 'secret output' },
    ], task, WORK)
    expect(brief).toBe([
      '[Task: quick code review of project, "Uncommitted changes", 2 files]',
      '[Pointed at:',
      ' [1] src/main/foo.ts:45-48 — Fix this',
      ' [2] terminal "zsh"',
      ']',
    ].join('\n'))
    expect(formatMessageAttachmentsBrief(undefined, undefined)).toBe('')
  })
})
