/**
 * The consolidating agent's instructions: the task, and what it is told when a
 * result has to be fixed or merged with changes made meanwhile.
 */

import { TOPIC_GUIDE, type ConcurrentChanges, type MemoryOwnerKind, type TopicConflict } from '../../platform/memory'

export const CONSOLIDATION_SYSTEM_PROMPT = `
You maintain the long-term memory of an AI agent. You work only on the files in
your current working directory: \`memory.md\` and the \`topics/\` folder. They are a
private copy; a backup of the original exists, and your result is checked before
it replaces anything. Still, be conservative with deletions.

Use Read, Edit, Write, Glob and Grep on files in this directory, and the
\`memory_move\` tool to move, rename or remove topic files and folders. Never refer
to or create files outside this directory.

The memory has three parts:
- \`memory.md\` \`# now\` — what is true right now across all the agent's work. Short.
- \`memory.md\` \`# History\` — what happened and when, newest first. Each entry is a
  \`## YYYY-MM-DD-HHmm | summary\` heading, possibly ending in \`[topic: ...]\` and
  \`[by: ...]\` tags.
- \`topics/\` — lasting knowledge, one subject per file, grouped into category
  folders like an encyclopedia.

${TOPIC_GUIDE}
`.trim()

export function buildConsolidationMessage(opts: {
  ownerName: string
  ownerKind: MemoryOwnerKind
  memoryBytes: number
  nowBytes: number
  topicCount: number
}): string {
  const whose = opts.ownerKind === 'space'
    ? `the space "${opts.ownerName}" (shared by all its conversations)`
    : `the digital human "${opts.ownerName}"`
  return `
Consolidate the memory of ${whose} — like sleep sorting a day into long-term
memory. memory.md is ${(opts.memoryBytes / 1024).toFixed(0)}KB, of which \`# now\` is
${(opts.nowBytes / 1024).toFixed(0)}KB; there are ${opts.topicCount} topics.

Goal: \`# now\` holds only what is true right now; lasting knowledge lives in
well-organised topics; nothing of value is lost.

1. \`# now\`: move each block of settled, lasting knowledge into a topic (extend an
   existing one if it fits, else create one), leaving a one-line pointer
   (\`- <subject>: <current state> → topic <path>\`). Drop state that has been
   superseded — keep only the latest value. Keep \`## State | ...\` first.
2. \`# History\`: keep the newest ~10 entries. Before dropping older ones, carry any
   lasting conclusion they hold into the matching topic. Keep \`[by: ...]\` and
   \`[topic: ...]\` tags verbatim on entries you keep; never invent one.
3. Topics: merge near-duplicates, split pages no longer readable in one go, group
   flat lists into categories, fix links broken by moves, add a description
   wherever one is missing. Descriptions say WHEN to read the page.
4. Never delete knowledge. To move, rename or remove a file or folder, use
   \`memory_move\` — a removal must name the topic that now holds its content.
5. Keep \`# now\` and \`# History\` as the two H1 headings of memory.md. Do not add a
   list of topics to memory.md.
6. Keep the memory's own voice and language. Do not add facts, commentary, or
   anything about this consolidation to the memory.

Finish with a short summary of what you moved, merged and split.
`.trim()
}

/** The last round ran out of turns while changes made meanwhile were still to merge. */
export const UNFINISHED_FEEDBACK = `
You ran out of steps before finishing. Your result has not replaced the memory.
Continue the work below from where the files are now.
`.trim()

/** Files a conflict asked to merge into that the last round left exactly as they were. */
export function buildUnmergedFeedback(targets: string[]): string {
  return `
Your result has not replaced the memory: nothing was merged into ${targets.map(t => `\`${t}\``).join(', ')} —
they are exactly as they were when the changes below were handed to you. Merge
those changes now.
`.trim()
}

/** A result that failed validation, handed back to be fixed. */
export function buildValidationFeedback(reason: string): string {
  return `
Your result was checked and cannot replace the memory yet:

${reason}

Fix this in the working directory, keeping everything else you did. Finish with a
one-line summary of the fix.
`.trim()
}

/**
 * A later round, complete on its own: the engine may not remember the first
 * one, so the task travels again with everything still to do.
 */
export function buildFollowUpMessage(task: string, feedback: string[]): string {
  return `
You are continuing a memory consolidation you already started. The files in the
current working directory are your work so far — continue from them; do not
start over or undo what is already done.

## The task

${task}

## What to do now

${feedback.join('\n\n')}
`.trim()
}

/**
 * What changed in the live memory while the agent worked that the system could
 * not merge alone. Nothing is abbreviated: live content is in `.incoming/`.
 */
export function buildConflictFeedback(changes: ConcurrentChanges): string {
  const parts: string[] = [
    'While you worked, other conversations changed the live memory in ways that overlap',
    'your work. Your result has not replaced it yet. Merge the changes below into your',
    'working copy — keep them, placed where your reorganisation puts that kind of',
    'knowledge — then finish again. Do not edit anything under `.incoming/`; it is only',
    'there for you to read.',
  ]
  if (changes.memory) {
    const { added, removed, incomingPath } = changes.memory
    parts.push('', '### memory.md (outside `# History`)')
    parts.push(`The live file, in full: \`${incomingPath}\`.`)
    const shown = 200
    if (added.length) {
      parts.push('Lines added — include them:', '```', ...added.slice(0, shown), '```')
      if (added.length > shown) parts.push(`… and ${added.length - shown} more added lines: read the live file above.`)
    }
    if (removed.length) {
      parts.push('Lines removed — drop them from your copy too:', '```', ...removed.slice(0, shown), '```')
      if (removed.length > shown) parts.push(`… and ${removed.length - shown} more removed lines: read the live file above.`)
    }
  }
  const byKind = (kind: TopicConflict['live']) => changes.topics.filter(t => t.live === kind)
  for (const t of [...byKind('changed'), ...byKind('added')]) {
    parts.push(
      '',
      `### topics/${t.path} — ${t.live === 'added' ? 'created' : 'changed'} live while you also changed it`,
      `The live version, in full: \`${t.incomingPath}\`. Merge its content into your topics.`
    )
  }
  const removedTopics = byKind('removed')
  if (removedTopics.length) {
    parts.push(
      '',
      `### Removed live: ${removedTopics.map(t => `topics/${t.path}`).join(', ')}`,
      'Someone removed these while you were changing or moving them. Drop them from your copy,',
      'including content you moved elsewhere, unless you are sure it is still needed.'
    )
  }
  const auto: string[] = []
  if (changes.carriedHistory) auto.push(`${changes.carriedHistory} History entries`)
  if (changes.mergedTopics) auto.push(`${changes.mergedTopics} topic changes you had not touched`)
  if (auto.length) parts.push('', `Already merged into your copy by the system: ${auto.join(' and ')}.`)
  return parts.join('\n')
}
