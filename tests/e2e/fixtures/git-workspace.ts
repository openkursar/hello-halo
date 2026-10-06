/**
 * A space whose working folder is a real git repository with one change of
 * every kind the changes view must show, plus a stored conversation that
 * exercises "View changes" and references. The changes view and the
 * reference specs run on it, and the end-to-end screenshots are taken on it.
 *
 * Repository `acme-app` (system temp directory), on `main`, tracking a local
 * bare `origin` and one commit ahead of it:
 *   staged      src/router/thinking.ts → src/router/thinking-budget.ts  renamed
 *   staged      src/router/reasoning-effort.ts                         modified
 *   unstaged    src/app.ts                                             modified (one line)
 *   unstaged    src/prompts/system-prompt.ts                           modified (> 40 lines)
 *   unstaged    src/router/provider-adapters.ts                        modified (one line of 120)
 *   unstaged    src/router/legacy-map.ts                               deleted
 *   unstaged    assets/logo.png                                        modified (binary)
 *   untracked   notes/todo.md
 *   generated   docs/generated/api.md (.gitattributes), package-lock.json  modified; hidden by default
 * plus `halo-local/`, a nested repository (ignored by the outer one) with an
 * unstaged change of its own.
 *
 * Conversation `Greeting update`: a request, an AI reply that edited
 * src/app.ts (Edit) and wrote notes/todo.md (Write) with the matching
 * `metadata.fileChanges`, and a user message carrying references: two comments
 * (a file range and terminal output, each with its note) and one selection
 * (a diff line).
 *
 * Seeding must happen before the app launches (the conversation store caches
 * what it read): `createGitWorkspace()` does all of it, then pass
 * `workspace.testConfigDir` to `launchElectronApp`. The app opens straight into
 * the seeded space (the only one) and its conversation.
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import esbuild from 'esbuild'
import electronPath from 'electron'
import { cleanupTestConfigDir, createTestConfigDir, getAppEntryPath } from './electron'
import type { ContentReference } from '../../../src/shared/types/content-reference'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const REPO_NAME = 'acme-app'
export const NESTED_REPO_NAME = 'halo-local'
export const SPACE_NAME = 'Acme app'
export const CONVERSATION_TITLE = 'Greeting update'

// ── File contents ───────────────────────────────────────────────────────────

/** Deterministic code-like lines, so long files read like code and never change between runs. */
function codeLines(name: string, count: number, seed: number): string[] {
  const words = ['config', 'profile', 'level', 'request', 'effort', 'model', 'session', 'upstream', 'thinking', 'budget']
  let state = seed
  const next = () => (state = (state * 9301 + 49297) % 233280) / 233280
  const pick = () => words[Math.floor(next() * words.length)]
  const lines = [`// ${name}`, '']
  for (let i = 0; i < count; i++) lines.push(`export const ${pick()}${i} = ${pick()}.${pick()}('${pick()}')`)
  return lines
}

const RULES: Array<[rule: string, why: string]> = [
  ['Read a file before editing it.', 'Edits to unread files overwrite work the model never saw.'],
  ['Prefer the dedicated file tools over shell commands.', 'They report precise errors and keep a record.'],
  ['Explain the next step before each tool call.', 'The user can stop a wrong turn early.'],
  ['Summarize every file you touched at the end.', 'Reviews start from the summary.'],
  ['Ask before deleting anything the user wrote.', 'Deletion is the one change that is hard to undo.'],
  ['Keep each reply focused on the request.', 'Unrequested changes slow down review.'],
  ['Use the to-do tool for work with several steps.', 'Progress stays visible while you work.'],
  ['Run the tests that cover what you changed.', 'A change is not done until it is checked.'],
  ['Quote file paths with line numbers.', 'The user can jump straight to the spot.'],
  ['Never print secrets from the environment.', 'Transcripts are shared and stored.'],
  ['Stop and ask when a request is ambiguous.', 'A wrong guess costs more than a question.'],
  ['Match the existing code style of the file.', 'Mixed styles make diffs noisy.'],
  ['Prefer small, reversible steps.', 'Each step can be reviewed on its own.'],
  ['Report failures with the exact error.', 'Paraphrased errors hide the cause.'],
  ['Do not invent APIs; read the source first.', 'Guessed APIs fail at runtime.'],
  ['Keep comments about why, not what.', 'The code already says what it does.'],
  ['Leave unrelated files alone.', 'Reviewers should see only the change.'],
  ['Write tests next to the code they cover.', 'Tests far from code go stale.'],
  ['Use the project scripts to build and test.', 'Ad-hoc commands drift from CI.'],
  ['Name things after what they mean.', 'Names are the first documentation.'],
  ['Handle the error paths you introduce.', 'Silent failures are the hardest bugs.'],
  ['Finish with what is left to do.', 'The user decides the next step.'],
]

function systemPrompt(revised: boolean): string {
  const lines = [
    'export function buildSystemPrompt(ctx: PromptContext): string {',
    '  return [',
    "    'You are Halo, an AI assistant that gets things done.',",
    "    '',",
  ]
  for (const [rule, why] of RULES) {
    lines.push(revised ? `    '- ${rule.replace(/\.$/, '')} — always.',` : `    '- ${rule}',`)
    lines.push(revised ? `    '  Reason: ${why.toLowerCase()}',` : `    '  Why: ${why}',`)
  }
  lines.push('    ctx.memory ? MEMORY_SECTION : \'\',', "  ].join('\\n')", '}', '')
  return lines.join('\n')
}

function reasoningEffort(revised: boolean): string {
  return [
    "import type { EffortLevel } from './types'",
    '',
    revised ? '/** Levels each model family accepts, highest first. */' : '/** Levels each model accepts. */',
    'const LEVELS: Record<string, EffortLevel[]> = {',
    "  claude: ['high', 'medium', 'low'],",
    revised ? "  gpt: ['high', 'medium', 'low', 'minimal']," : "  gpt: ['high', 'medium', 'low'],",
    '}',
    '',
    'export function clampEffort(model: string, wanted: EffortLevel): EffortLevel {',
    '  const levels = LEVELS[model] ?? LEVELS.claude',
    revised ? '  if (levels.includes(wanted)) return wanted' : '  return levels.includes(wanted) ? wanted : levels[0]',
    ...(revised ? ['  return levels[levels.length - 1]'] : []),
    '}',
    '',
  ].join('\n')
}

function providerAdapters(changed: boolean): string {
  const lines = codeLines('provider-adapters.ts', 120, 13)
  if (changed) lines[62] = 'export const session60 = settings.upstream.retry(3)'
  return `${lines.join('\n')}\n`
}

/** Two different small binary images: a PNG signature, then bytes with NULs in them. */
function logo(variant: number): Buffer {
  const body = Buffer.alloc(1024 + variant * 37)
  for (let i = 0; i < body.length; i++) body[i] = (i * (variant + 2)) % 251
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body])
}

/** HEAD's version of each committed text file (assets/logo.png is binary, written separately). */
export const BASELINE: Record<string, string> = {
  'AGENTS.md': '# Rules\n\n- Keep modules small.\n- Comments explain why, not what.\n',
  'README.md': '# Acme app\n\nA small repository the changes view is tested against.\n',
  '.gitattributes': 'docs/generated/** linguist-generated\n',
  '.gitignore': `${NESTED_REPO_NAME}/\nnode_modules/\n`,
  'package.json': `${JSON.stringify({ name: 'acme-app', version: '1.0.0', scripts: { test: 'vitest' } }, null, 2)}\n`,
  'package-lock.json': `${JSON.stringify({ name: 'acme-app', lockfileVersion: 3, packages: { '': { name: 'acme-app', version: '1.0.0' } } }, null, 2)}\n`,
  'src/app.ts': [
    "import { formatTotal } from './util'",
    '',
    "const greeting = 'hello'",
    '',
    'export function main(items: number[]): string {',
    '  return `${greeting}: ${formatTotal(items)}`',
    '}',
    '',
  ].join('\n'),
  'src/util.ts': [
    'export function formatTotal(items: number[]): string {',
    '  const total = items.reduce((sum, item) => sum + item, 0)',
    '  return total.toFixed(2)',
    '}',
    '',
  ].join('\n'),
  'src/prompts/system-prompt.ts': systemPrompt(false),
  'src/router/provider-adapters.ts': providerAdapters(false),
  'src/router/legacy-map.ts': `${codeLines('legacy-map.ts', 30, 11).join('\n')}\n`,
  'src/router/thinking.ts': `${codeLines('thinking.ts', 40, 7).join('\n')}\n`,
  'src/router/reasoning-effort.ts': reasoningEffort(false),
  'docs/guide.md': '# Guide\n\nStart with `npm start`.\n',
  'docs/generated/api.md': '# API\n\n- listRepositories\n',
}

/** The edits on top of the baseline; the seeded reply made the first and the last. */
export const EDITS = {
  appBefore: "const greeting = 'hello'",
  appAfter: "const greeting = 'hello, world'",
  todo: '# To do\n\n- Greet the whole world\n- Format totals with two decimals\n',
} as const

export interface ExpectedFile {
  /** As the file panel titles it: the path, or "old → new" for a rename. */
  title: string
  /** Letter the file panel shows. */
  letter: 'M' | 'A' | 'D' | 'R' | 'U'
}

/** What the file panel lists for the seeded repository, generated files hidden (the default). */
export const EXPECTED_STATUS: { staged: ExpectedFile[]; unstaged: ExpectedFile[]; hiddenGenerated: string[] } = {
  staged: [
    { title: 'src/router/thinking.ts → src/router/thinking-budget.ts', letter: 'R' },
    { title: 'src/router/reasoning-effort.ts', letter: 'M' },
  ],
  unstaged: [
    { title: 'assets/logo.png', letter: 'M' },
    { title: 'src/app.ts', letter: 'M' },
    { title: 'src/prompts/system-prompt.ts', letter: 'M' },
    { title: 'src/router/provider-adapters.ts', letter: 'M' },
    { title: 'src/router/legacy-map.ts', letter: 'D' },
    { title: 'notes/todo.md', letter: 'U' },
  ],
  hiddenGenerated: ['docs/generated/api.md', 'package-lock.json'],
}

// ── Seeding ─────────────────────────────────────────────────────────────────

export interface GitWorkspaceSeedRequest {
  repoRoot: string
  spaceName: string
  conversationTitle: string
  userMessage: string
  replyText: string
  edits: Array<
    | { tool: 'Write'; filePath: string; content: string }
    | { tool: 'Edit'; filePath: string; oldString: string; newString: string }
  >
  followUp: { content: string; references: ContentReference[] }
}

export interface GitWorkspaceSeed {
  spaceId: string
  conversationId: string
  /** The AI reply that carries the Write / Edit records. */
  replyMessageId: string
  /** The user message that carries references (comments and a selection). */
  followUpMessageId: string
}

export interface GitWorkspace extends GitWorkspaceSeed {
  /** The E2E profile root to hand to `launchElectronApp`. */
  testConfigDir: string
  /** Absolute repository root; also the space's working folder. */
  repoRoot: string
  /** The nested repository inside it. */
  nestedRepoRoot: string
  /** The bare repository `origin` points at. */
  originRoot: string
  /** Run git in the repository (isolated from the user's git config). */
  git: (...args: string[]) => string
  /** A working-tree file as text. */
  readFile: (repoPath: string) => string
  /** Remove the profile and the repositories. */
  cleanup: () => void
}

function gitIn(cwd: string, emptyConfig: string): (...args: string[]) => string {
  return (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // No user or system config, so the repository is the same on every machine.
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0' },
    })
}

function writeFile(root: string, repoPath: string, content: string | Buffer): void {
  const file = path.join(root, ...repoPath.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function initRepository(root: string, git: (...args: string[]) => string): void {
  fs.mkdirSync(root, { recursive: true })
  git('init', '-q')
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  // The app runs git with HOME set to the test profile, which has no identity:
  // the repository carries its own so commits made from the UI succeed.
  git('config', 'user.name', 'Halo E2E')
  git('config', 'user.email', 'e2e@halo.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
}

function createRepositories(holder: string, emptyConfig: string): { repoRoot: string; nestedRepoRoot: string; originRoot: string; head: string } {
  const repoRoot = path.join(holder, REPO_NAME)
  const originRoot = path.join(holder, 'origin.git')
  const nestedRepoRoot = path.join(repoRoot, NESTED_REPO_NAME)
  const git = gitIn(repoRoot, emptyConfig)

  fs.mkdirSync(originRoot, { recursive: true })
  gitIn(originRoot, emptyConfig)('init', '-q', '--bare')

  initRepository(repoRoot, git)
  for (const [repoPath, content] of Object.entries(BASELINE)) writeFile(repoRoot, repoPath, content)
  writeFile(repoRoot, 'assets/logo.png', logo(1))
  git('add', '-A')
  git('commit', '-q', '-m', 'Initial import')
  git('remote', 'add', 'origin', originRoot)
  git('push', '-q', '-u', 'origin', 'main')

  // One commit the upstream does not have yet.
  writeFile(repoRoot, 'README.md', `${BASELINE['README.md']}\nRun \`npm test\` before every commit.\n`)
  git('commit', '-q', '-am', 'Document the test command')

  // Staged: a rename and a modification.
  git('mv', 'src/router/thinking.ts', 'src/router/thinking-budget.ts')
  writeFile(repoRoot, 'src/router/reasoning-effort.ts', reasoningEffort(true))
  git('add', 'src/router/reasoning-effort.ts')

  // Unstaged: small, large and binary modifications, a deletion, generated files.
  writeFile(repoRoot, 'src/app.ts', BASELINE['src/app.ts'].replace(EDITS.appBefore, EDITS.appAfter))
  writeFile(repoRoot, 'src/prompts/system-prompt.ts', systemPrompt(true))
  writeFile(repoRoot, 'src/router/provider-adapters.ts', providerAdapters(true))
  fs.rmSync(path.join(repoRoot, 'src', 'router', 'legacy-map.ts'))
  writeFile(repoRoot, 'assets/logo.png', logo(2))
  writeFile(repoRoot, 'docs/generated/api.md', '# API\n\n- listRepositories\n- getStatus\n- getChanges\n')
  writeFile(repoRoot, 'package-lock.json', BASELINE['package-lock.json'].replace('"version": "1.0.0"', '"version": "1.0.1"'))

  // Untracked.
  writeFile(repoRoot, 'notes/todo.md', EDITS.todo)

  // A nested repository with a change of its own.
  const nested = gitIn(nestedRepoRoot, emptyConfig)
  initRepository(nestedRepoRoot, nested)
  writeFile(nestedRepoRoot, 'README.md', '# halo-local\n\nLocal tools.\n')
  nested('add', '-A')
  nested('commit', '-q', '-m', 'Initial import')
  writeFile(nestedRepoRoot, 'README.md', '# halo-local\n\nLocal tools for the end-to-end run.\n')

  return { repoRoot, nestedRepoRoot, originRoot, head: git('rev-parse', 'HEAD').trim() }
}

let bundledWorker: string | null = null

/** Bundles the seed worker once per run (output stays under the project so `electron` resolves). */
function seedWorker(): string {
  if (bundledWorker && fs.existsSync(bundledWorker)) return bundledWorker
  const outDir = path.join(__dirname, '.e2e-seed-tmp')
  fs.mkdirSync(outDir, { recursive: true })
  const outfile = path.join(outDir, `git-workspace-seed-worker-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'git-workspace-seed-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile,
    external: ['better-sqlite3', 'electron', '@parcel/watcher'],
    logLevel: 'silent',
  })
  bundledWorker = outfile
  return outfile
}

function seedRequest(repoRoot: string, head: string, replyEditCount: number): GitWorkspaceSeedRequest {
  const at = (...segments: string[]) => path.join(repoRoot, ...segments)
  return {
    repoRoot,
    spaceName: SPACE_NAME,
    conversationTitle: CONVERSATION_TITLE,
    userMessage: 'Greet the whole world and keep a to-do list of what is left.',
    replyText: 'Updated the greeting in `src/app.ts:3` and added `notes/todo.md` with the remaining work.',
    edits: [
      ...Array.from({ length: replyEditCount }, (_, index): GitWorkspaceSeedRequest['edits'][number] => ({
        tool: 'Edit', filePath: at('src', 'app.ts'),
        oldString: index === 0 ? EDITS.appBefore : `export const item${index} = ${index}`,
        newString: index === 0 ? EDITS.appAfter : `export const item${index} = ${index + 1}`,
      })),
      { tool: 'Write', filePath: at('notes', 'todo.md'), content: EDITS.todo },
    ],
    followUp: {
      content: 'Fix the rounding and the failing test, and keep the selected greeting in one shared constant.',
      references: [
        {
          id: 'seed-ref-file',
          source: { kind: 'file', path: at('src', 'util.ts'), precision: 'lines' },
          range: { startLine: 2, endLine: 3 },
          quote: '  const total = items.reduce((sum, item) => sum + item, 0)\n  return total.toFixed(2)',
          note: 'Round half up instead of toFixed',
        },
        {
          id: 'seed-ref-diff',
          source: { kind: 'diff', path: at('src', 'app.ts'), side: 'after', compareLabel: 'Uncommitted changes', repo: { root: repoRoot, beforeRevision: head } },
          range: { startLine: 3, endLine: 3 },
          quote: EDITS.appAfter,
        },
        {
          id: 'seed-ref-terminal',
          source: { kind: 'terminal', title: 'zsh' },
          quote: '$ npm test\n FAIL  src/util.test.ts > formatTotal rounds half up\n   expected "2.68" to be "2.69"',
          note: 'This is the failure',
        },
      ],
    },
  }
}

/** Create the profile, the repositories and the seeded space + conversation. */
export function createGitWorkspace(replyEditCount = 1, replyText?: (repoRoot: string) => string): GitWorkspace {
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const holder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-e2e-git-')))
  const emptyConfig = path.join(holder, 'empty.gitconfig')
  fs.writeFileSync(emptyConfig, '')
  const cleanup = () => {
    cleanupTestConfigDir(testConfigDir)
    fs.rmSync(holder, { recursive: true, force: true })
  }

  try {
    const { repoRoot, nestedRepoRoot, originRoot, head } = createRepositories(holder, emptyConfig)
    const request = seedRequest(repoRoot, head, replyEditCount)
    if (replyText) request.replyText = replyText(repoRoot)
    const output = execFileSync(electronPath as unknown as string, [seedWorker(), JSON.stringify(request)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HALO_DATA_DIR: path.join(testConfigDir, '.halo') },
      encoding: 'utf-8',
    })
    const seed = JSON.parse(output.trim().split('\n').pop() ?? '') as GitWorkspaceSeed
    return {
      ...seed,
      testConfigDir,
      repoRoot,
      nestedRepoRoot,
      originRoot,
      git: gitIn(repoRoot, emptyConfig),
      readFile: (repoPath) => fs.readFileSync(path.join(repoRoot, ...repoPath.split('/')), 'utf8'),
      cleanup,
    }
  } catch (error) {
    cleanup()
    throw error
  }
}
