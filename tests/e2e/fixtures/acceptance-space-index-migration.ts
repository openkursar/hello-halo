import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type SpaceIndexDataset = 'space-index-v1' | 'space-index-v2'

export interface HistoricalConversation {
  version?: number
  id: string
  spaceId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview: string
  messages: Array<{ id: string; role: string; content: string; timestamp: string }>
}

export interface HistoricalSpace {
  path: string
  registered: boolean
  meta: {
    id: string
    name: string
    icon: string
    createdAt: string
    updatedAt: string
    workingDir?: string
    preferences?: { layout: { artifactRailExpanded: boolean; chatWidth: number } }
  }
  conversations: HistoricalConversation[]
}

interface HistoricalInput {
  dataset: SpaceIndexDataset
  historicalProducer: string
  index: { customPaths?: string[]; version?: number; spaces?: Record<string, { path: string }> }
  expectedOrder: string[]
  workSpaceId: string
  spaces: HistoricalSpace[]
}

// These inputs freeze the old producer formats, not the current migration output.
export function spaceIndexFixture(dataset: SpaceIndexDataset) {
  assert.ok(dataset === 'space-index-v1' || dataset === 'space-index-v2')
  const bytes = readFileSync(new URL(`./data/${dataset}.json`, import.meta.url))
  const input = JSON.parse(bytes.toString('utf8')) as HistoricalInput
  assert.equal(input.dataset, dataset)
  return { input, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function contained(root: string, path: string) {
  const part = relative(root, path)
  assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`), 'Historical data must stay inside the owned profile')
  return path
}

function safePath(root: string, path: string) {
  contained(root, path)
  let current = root
  for (const segment of relative(root, path).split(sep)) {
    current = join(current, segment)
    try { assert.equal(lstatSync(current).isSymbolicLink(), false, 'Historical data must not traverse symbolic links') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return path
}

function substitute(root: string, template: string) {
  assert.ok(template.startsWith('$PROFILE/'), 'Historical paths require an explicit owned-profile placeholder')
  return safePath(root, resolve(root, template.slice('$PROFILE/'.length)))
}

export function migrationFileIdentity(file: string) {
  const bytes = readFileSync(file)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mtimeMs: statSync(file).mtimeMs }
}

export function installLegacySpaceIndex(profile: string, child: Pick<ChildProcess, 'exitCode' | 'signalCode'>, dataset: SpaceIndexDataset) {
  assert.ok(child.exitCode != null || child.signalCode != null, 'Historical input requires the owned application to have exited')
  const root = realpathSync(profile)
  const fixture = spaceIndexFixture(dataset)
  const input = fixture.input
  const spacesDirectory = safePath(root, join(root, '.halo', 'spaces'))
  assert.ok(lstatSync(spacesDirectory).isDirectory())
  assert.deepEqual(readdirSync(spacesDirectory), [], 'Only a fresh profile with no dedicated workspaces may receive historical input')
  const index = safePath(root, join(root, '.halo', 'spaces-index.json'))
  if (existsSync(index)) {
    assert.ok(lstatSync(index).isFile())
    const initial = JSON.parse(readFileSync(index, 'utf8'))
    assert.deepEqual(initial, { version: 3, spaces: {} }, 'Existing workspace records must never be overwritten')
  }
  const spaces = input.spaces.map(space => ({
    ...space, path: substitute(root, space.path),
    meta: { ...space.meta, ...(space.meta.workingDir ? { workingDir: substitute(root, space.meta.workingDir) } : {}) },
  }))
  for (const space of spaces) {
    assert.throws(() => lstatSync(space.path), { code: 'ENOENT' }, 'Historical directories must be new')
    if (space.meta.workingDir) assert.throws(() => lstatSync(space.meta.workingDir!), { code: 'ENOENT' })
    assert.match(space.meta.id, /^[a-z0-9-]+$/)
    for (const conversation of space.conversations) {
      assert.match(conversation.id, /^[a-z0-9-]+$/)
      assert.equal(conversation.spaceId, space.meta.id)
      assert.equal(conversation.messageCount, conversation.messages.length)
    }
  }
  const files: Array<{ path: string; identity: ReturnType<typeof migrationFileIdentity> }> = []
  const write = (file: string, contents: string) => {
    safePath(root, file)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents, { flag: 'wx' })
    files.push({ path: file, identity: migrationFileIdentity(file) })
  }
  for (const space of spaces) {
    write(join(space.path, '.halo', 'meta.json'), JSON.stringify(space.meta, null, 2) + '\n')
    write(join(space.path, 'original-control.txt'), `Original files for ${space.meta.id}.\n`)
    if (space.meta.workingDir) write(join(space.meta.workingDir, 'original-control.txt'), `Original working directory for ${space.meta.id}.\n`)
    const conversationDirectory = join(space.path, '.halo', 'conversations')
    for (const conversation of space.conversations) write(join(conversationDirectory, `${conversation.id}.json`), JSON.stringify(conversation, null, 2) + '\n')
    const metadata = space.conversations.map(({ messages: _messages, version: _version, ...meta }) => meta)
    write(join(conversationDirectory, 'index.json'), JSON.stringify({ version: 1, updatedAt: space.meta.updatedAt, conversations: metadata }, null, 2) + '\n')
  }
  const historicalIndex = dataset === 'space-index-v1'
    ? { customPaths: input.index.customPaths!.map(path => substitute(root, path)) }
    : { version: 2, spaces: Object.fromEntries(Object.entries(input.index.spaces!).map(([id, entry]) => [id, { path: substitute(root, entry.path) }])) }
  writeFileSync(index, JSON.stringify(historicalIndex, null, 2) + '\n')
  return { root, dataset, producer: input.historicalProducer, fixtureHash: fixture.sha256, index, spaces, expectedOrder: input.expectedOrder, workSpaceId: input.workSpaceId, files }
}

function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'` }

export function createMigrationCommand(profile: string, executable: string, platform: string) {
  const root = realpathSync(profile)
  const marker = randomUUID()
  const outputName = `migration-work-${marker}.json`
  const script = safePath(root, join(root, `migration-work-${marker}.cjs`))
  const program = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    `const root = fs.realpathSync(${JSON.stringify(root)})`,
    'const cwd = fs.realpathSync(process.cwd())',
    'const within = path.relative(root, cwd)',
    "if (!within || path.isAbsolute(within) || within === '..' || within.startsWith('..' + path.sep)) throw new Error('Refusing work outside the owned profile')",
    `const receipt = { cwd, marker: ${JSON.stringify(marker)} }`,
    `fs.writeFileSync(${JSON.stringify(outputName)}, JSON.stringify(receipt), { flag: 'wx' })`,
    'process.stdout.write(JSON.stringify(receipt))',
  ].join('\n')
  writeFileSync(script, program, { flag: 'wx' })
  const shellPath = (value: string) => platform === 'win32' ? value.replaceAll('\\', '/') : value
  return { marker, outputName, script, command: `ELECTRON_RUN_AS_NODE=1 ${shellQuote(shellPath(executable))} ${shellQuote(shellPath(script))}` }
}
