/**
 * Seeding worker for git-workspace.ts — runs under Electron's own Node runtime
 * (see seed-app.ts for why this cannot run in-process). It calls the real
 * space and conversation services, so the seeded space and messages are
 * schema-identical to what the app itself writes.
 *
 * Contract: argv[2] is a JSON-encoded GitWorkspaceSeedRequest; the seeded
 * GitWorkspaceSeed is printed to stdout as the last line.
 */

import { createSpace, flushSpaceActivity } from '../../../src/main/services/space.service'
import {
  addMessage,
  createConversation,
  flushAllPendingIndexWrites,
  updateLastMessage,
} from '../../../src/main/services/conversation.service'
import { parseReferences } from '../../../src/shared/content-reference'
import { extractFileChangesSummaryFromThoughts } from '../../../src/shared/file-changes'
import type { Thought } from '../../../src/shared/types/transcript'
import type { GitWorkspaceSeed, GitWorkspaceSeedRequest } from './git-workspace'

function main(): void {
  const raw = process.argv[2]
  if (!raw) throw new Error('git-workspace-seed-worker: missing argv[2] payload')
  const request = JSON.parse(raw) as GitWorkspaceSeedRequest

  const references = parseReferences(request.followUp.references)
  if (!references.ok) throw new Error(`git-workspace-seed-worker: invalid references: ${references.error}`)

  const space = createSpace({ name: request.spaceName, icon: 'folder', customPath: request.repoRoot })
  const conversation = createConversation(space.id, request.conversationTitle, undefined, { keepTitle: true })
  addMessage(space.id, conversation.id, { role: 'user', content: request.userMessage })

  const at = new Date().toISOString()
  const thoughts: Thought[] = request.edits.map((edit, index) => ({
    id: `seed-edit-${index + 1}`,
    type: 'tool_use',
    content: '',
    timestamp: at,
    toolName: edit.tool,
    toolInput: edit.tool === 'Write'
      ? { file_path: edit.filePath, content: edit.content }
      : { file_path: edit.filePath, old_string: edit.oldString, new_string: edit.newString },
    toolResult: { output: edit.tool === 'Write' ? 'File created successfully' : 'File updated successfully', isError: false, timestamp: at },
  }))
  const fileChanges = extractFileChangesSummaryFromThoughts(thoughts)
  const reply = addMessage(space.id, conversation.id, {
    role: 'assistant',
    content: request.replyText,
    ...(fileChanges ? { metadata: { fileChanges } } : {}),
  })
  // Moves the thoughts beside the conversation and leaves `thoughts: null`, as a finished turn does.
  updateLastMessage(space.id, conversation.id, { thoughts })

  const followUp = addMessage(space.id, conversation.id, {
    role: 'user',
    content: request.followUp.content,
    metadata: { references: references.references },
  })

  flushAllPendingIndexWrites()
  flushSpaceActivity()

  const result: GitWorkspaceSeed = {
    spaceId: space.id,
    conversationId: conversation.id,
    replyMessageId: reply.id,
    followUpMessageId: followUp.id,
  }
  // Last stdout line only; exit at once so no debounced log lands after it.
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(0)
}

main()
