/**
 * Agent Module - References and Tasks in a User Turn
 *
 * Besides its text, a user message can carry the places the user pointed at
 * (`metadata.references`) and a built-in task (`metadata.task`). The
 * transcript keeps those records; the model reads them expanded into the
 * `<halo_references>` and `<halo_task>` blocks built here, placed ahead of
 * the message text. Every chat entry (space chat, digital-human chat,
 * mid-turn injection) builds them through this module, so a reference reads
 * the same wherever it is sent. What a task asks for is its owner's to word
 * (a code review's instructions come from services/code-review); this module
 * only frames it.
 */

import {
  displayPath,
  formatLineRange,
  isQuoteAtLimit,
  quoteCharLimit,
  quoteKeptEnd,
  referenceLocationText,
  truncateChars,
} from '../../../shared/content-reference'
import type { ContentReference, ReferenceLineRange } from '../../../shared/types/content-reference'
import type { MessageTask } from '../../../shared/types/message-task'
import { inlinePath, inlineText, neutralizeBlockTags } from './prompt-text'

/** Excerpt characters one block carries; later excerpts are left out once it is spent. */
const EXCERPT_BUDGET = 100_000
/** Ceiling on one block; references past it are counted, not shown. */
const MAX_BLOCK_CHARS = 160_000

const REFERENCES_INTRO =
  'The user pointed at these places, listed in the order they added them. A Note is the user\'s request about that place. ' +
  'The numbers only separate the entries and are not shown to the user: when you refer to a place, name it by its location (for a file, `path:line`). ' +
  'Excerpts show the text as it was when the user pointed at it; for files, read the file for its current content.'

const FENCE_LANGUAGES: Record<string, string> = {
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  zsh: 'bash',
  kt: 'kotlin',
}

function fenceLanguage(ref: ContentReference): string {
  const { source } = ref
  if (source.kind === 'message') return 'markdown'
  if (source.kind !== 'file' && source.kind !== 'diff') return ''
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(source.path)
  if (!match) return ''
  const ext = match[1].toLowerCase()
  return FENCE_LANGUAGES[ext] ?? ext
}

/** A Markdown fence longer than any run of backticks in the text it wraps. */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

function linesText(range: ReferenceLineRange | undefined): string {
  if (!range) return ''
  return range.startLine === range.endLine ? `line ${range.startLine}` : `lines ${formatLineRange(range)}`
}

function describeSource(ref: ContentReference, workDir: string | undefined): string {
  const { source } = ref
  const lines = linesText(ref.range)
  const path = (p: string) => inlinePath(displayPath(p, workDir))
  switch (source.kind) {
    case 'file': {
      if (source.precision === 'passage') {
        return `${path(source.path)}, a passage of the rendered document${lines ? ` near ${lines}` : ''} (locate it by the excerpt)`
      }
      return lines ? `${path(source.path)}, ${lines}` : path(source.path)
    }
    case 'diff': {
      const details: string[] = []
      if (source.repo) {
        const repo = path(source.repo.root)
        if (repo !== '.') details.push(`repository ${repo}`)
        if (source.repo.beforeRevision) details.push(`before revision ${inlineText(source.repo.beforeRevision, 64)}`)
      }
      // A diff of a reply's edits has no file line numbers: only its excerpt locates it.
      return `Diff "${inlineText(source.compareLabel)}" of ${path(source.path)}, ${source.side} side`
        + (lines ? `, ${lines}` : ref.quote ? ' (locate it by the excerpt)' : '')
        + (details.length > 0 ? ` (${details.join(', ')})` : '')
    }
    case 'terminal':
      return `Terminal output, tab "${inlineText(source.title)}"${source.sessionId ? ` (terminal session ${inlineText(source.sessionId, 200)})` : ''}`
    case 'message': {
      const what = source.whole ? 'Whole message' : 'Passage of a message'
      const title = source.conversationTitle ? `"${inlineText(source.conversationTitle)}" ` : ''
      return `${what} in conversation ${title}(conversation ${inlineText(source.conversationId, 200)}, message ${inlineText(source.messageId, 200)})`
    }
    case 'path': {
      const shown = displayPath(source.path, workDir)
      const folder = source.isDirectory && !/[\\/]$/.test(shown) ? `${shown}/` : shown
      return `Attached ${source.isDirectory ? 'folder' : 'file'}: ${inlinePath(folder)}`
    }
  }
}

function excerptLabel(ref: ContentReference, quote: string): string {
  const kind = ref.source.kind
  if (!isQuoteAtLimit(kind, quote)) return 'Excerpt:'
  const end = quoteKeptEnd(kind) === 'end' ? 'last' : 'first'
  return `Excerpt (possibly cut to its ${end} ${quoteCharLimit(kind).toLocaleString('en-US')} characters):`
}

/**
 * The `<halo_references>` block for a message's references, in the order the
 * user added them; '' when there are none. Its numbers only separate entries
 * (the user never sees them). Paths inside `workDir` are shown relative to it.
 */
export function formatReferencesBlock(references: readonly ContentReference[] | undefined, workDir: string | undefined): string {
  if (!references || references.length === 0) return ''
  const entries: string[] = []
  let excerptBudget = EXCERPT_BUDGET
  let size = 0
  let omittedExcerpts = 0
  let omittedReferences = 0

  for (let i = 0; i < references.length; i++) {
    const ref = references[i]
    const lines = [`[${i + 1}] ${describeSource(ref, workDir)}`]
    if (ref.note) lines.push(`Note: ${neutralizeBlockTags(ref.note)}`)
    if (ref.quote) {
      if (ref.quote.length <= excerptBudget) {
        excerptBudget -= ref.quote.length
        const quote = neutralizeBlockTags(ref.quote)
        const fence = fenceFor(quote)
        lines.push(excerptLabel(ref, ref.quote), `${fence}${fenceLanguage(ref)}`, quote, fence)
      } else {
        omittedExcerpts += 1
        lines.push('Excerpt: left out to keep this message small; read the source instead.')
      }
    }
    const entry = lines.join('\n')
    if (size + entry.length > MAX_BLOCK_CHARS) {
      omittedReferences = references.length - i
      break
    }
    size += entry.length
    entries.push(entry)
  }

  if (omittedExcerpts > 0 || omittedReferences > 0) {
    console.warn(`[Agent] References block bounded: ${omittedExcerpts} excerpt(s) and ${omittedReferences} reference(s) left out of ${references.length}`)
  }
  const tail = omittedReferences > 0
    ? `\n\n[${references.length - omittedReferences + 1}-${references.length}] ${omittedReferences} more place(s) left out: this message is too long to carry them.`
    : ''
  return `<halo_references>\n${REFERENCES_INTRO}\n\n${entries.join('\n\n')}${tail}\n</halo_references>\n\n`
}

/**
 * The `<halo_task>` block framing a task's instructions; '' without a task.
 * The instructions are written by the task's owner and only framed here.
 */
export function formatTaskBlock(task: MessageTask | undefined, instructions: string | undefined): string {
  if (!task) return ''
  if (!instructions) {
    console.warn(`[Agent] ${task.type} task sent without instructions; the model sees only the message text`)
    return ''
  }
  const variant = task.type === 'code-review' ? ` variant="${task.variant}"` : ''
  return `<halo_task type="${task.type}"${variant}>\n${neutralizeBlockTags(instructions)}\n</halo_task>\n\n`
}

/**
 * What a user turn carries besides its text, as the model reads it: the
 * references block, then the task block. Entries place it after their own
 * context (memory, canvas) and before the image fallback and the text.
 */
export function formatTurnAttachments(input: {
  references?: readonly ContentReference[]
  task?: MessageTask
  /** The task's instructions, written by its owner. */
  taskInstructions?: string
  workDir: string
}): string {
  return formatReferencesBlock(input.references, input.workDir) + formatTaskBlock(input.task, input.taskInstructions)
}

/** Characters of a note shown in the brief form. */
const BRIEF_NOTE_CHARS = 200

/**
 * A message's references and task in a few lines, for a reader that sees the
 * message from outside its conversation (cross-conversation reads): where the
 * places are and what the user said about them, never the excerpts.
 */
export function formatMessageAttachmentsBrief(
  references: readonly ContentReference[] | undefined,
  task: MessageTask | undefined,
  workDir?: string
): string {
  const lines: string[] = []
  if (task?.type === 'code-review') {
    lines.push(`[Task: ${task.variant} code review of ${inlineText(task.repoName, 200)}, "${inlineText(task.scopeLabel, 200)}", ${task.fileCount} files]`)
  }
  if (references && references.length > 0) {
    lines.push('[Pointed at:')
    references.forEach((ref, i) => {
      const where = ref.source.kind === 'path' || ref.source.kind === 'file' || ref.source.kind === 'diff'
        ? `${inlinePath(displayPath(ref.source.path, workDir))}${ref.range ? `:${formatLineRange(ref.range)}` : ''}`
        : ref.source.kind === 'terminal'
          ? `terminal "${inlineText(ref.source.title)}"`
          : `message in "${inlineText(referenceLocationText(ref) || ref.source.conversationId)}"`
      const note = ref.note
        ? ` — ${inlineText(truncateChars(ref.note, BRIEF_NOTE_CHARS))}${ref.note.length > BRIEF_NOTE_CHARS ? '…' : ''}`
        : ''
      lines.push(` [${i + 1}] ${where}${note}`)
    })
    lines.push(']')
  }
  return lines.join('\n')
}
