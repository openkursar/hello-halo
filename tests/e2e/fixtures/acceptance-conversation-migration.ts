import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { TranscriptMessage } from '../../../src/shared/types/transcript'

interface LegacyConversation {
  id: string
  spaceId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview: string
  messages: TranscriptMessage[]
}

// Frozen from the unversioned format in 18da351e3cd215aff144213714a48e9be9250a66,
// src/main/services/conversation.service.ts. It deliberately has no SDK session or format marker.
const source = readFileSync(new URL('./data/conversation-v1.json', import.meta.url), 'utf8')

export function legacyConversationFixture(spaceId: string, conversationId: string): LegacyConversation {
  return { ...JSON.parse(source), id: conversationId, spaceId }
}

export function legacyConversationIdentity() {
  return { format: 'unversioned inline thoughts', sha256: createHash('sha256').update(source).digest('hex') }
}

function owned(profile: string, path: string) {
  const location = relative(realpathSync(profile), realpathSync(path))
  assert.ok(location && !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`), 'Migration data must belong to the isolated profile')
  assert.equal(lstatSync(path).isSymbolicLink(), false, 'Migration targets must not be symbolic links')
  return path
}

export function installLegacyConversation(profile: string, child: Pick<ChildProcess, 'exitCode' | 'signalCode'>, spacePath: string, spaceId: string, conversationId: string) {
  assert.ok(child.exitCode != null || child.signalCode != null, 'Conversation mutation requires the owned application process to have exited')
  assert.match(conversationId, /^[a-zA-Z0-9-]+$/, 'Conversation identity must be a single file name')
  const directory = owned(profile, join(spacePath, '.halo', 'conversations'))
  const main = owned(profile, join(directory, `${conversationId}.json`))
  const index = owned(profile, join(directory, 'index.json'))
  const current = JSON.parse(readFileSync(main, 'utf8'))
  assert.equal(current.id, conversationId)
  assert.equal(current.spaceId, spaceId)
  assert.equal(current.version, 2, 'A new conversation format requires reviewing the historical fixture boundary')
  assert.deepEqual(current.messages, [], 'Only the empty conversation precondition may become historical input')
  const thoughts = join(directory, `${conversationId}.thoughts.json`)
  assert.throws(() => lstatSync(thoughts), { code: 'ENOENT' }, 'Historical input must not inherit a newer thoughts file or link')
  const previousIndex = JSON.parse(readFileSync(index, 'utf8'))
  assert.equal(previousIndex.version, 1)
  assert.equal(previousIndex.conversations.filter((entry: { id: string }) => entry.id === conversationId).length, 1)
  const legacy = legacyConversationFixture(spaceId, conversationId)
  const { messages: _messages, ...meta } = legacy
  writeFileSync(main, JSON.stringify(legacy, null, 2) + '\n')
  const entries = previousIndex.conversations.map((entry: { id: string }) => entry.id === conversationId ? meta : entry)
  entries.sort((a: { updatedAt: string }, b: { updatedAt: string }) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  writeFileSync(index, JSON.stringify({ ...previousIndex, conversations: entries }, null, 2))
  return { legacy, main, thoughts }
}

export function conversationFileIdentity(file: string) {
  const bytes = readFileSync(file)
  const stat = statSync(file)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.toString('utf8'), mtimeMs: stat.mtimeMs }
}
