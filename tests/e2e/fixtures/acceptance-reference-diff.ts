import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createReferenceDiffRepository(profile: string) {
  const holder = join(realpathSync(profile), 'reference-diff')
  const root = join(holder, 'repository')
  const emptyConfig = join(holder, 'empty-git-config')
  const emptyHooks = join(holder, 'empty-hooks')
  mkdirSync(holder)
  mkdirSync(root)
  mkdirSync(emptyHooks)
  writeFileSync(emptyConfig, '')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Synthetic Acceptance', '-c', 'user.email=acceptance@halo.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${emptyHooks}`,
    ...args,
  ], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
  const word = (prefix: string) => `${prefix}${randomUUID().replaceAll('-', '')}`
  const before = word('Before')
  const after = word('After')
  const companion = word('Companion')
  const unrelated = word('Unselected')
  const revisedPath = join(root, 'revision.ts')
  const companionPath = join(root, 'companion.ts')
  const controlPath = join(root, 'unselected.ts')
  const original = `// Historical declaration\nexport const ${before} = 13\nexport const stable = 31\n`
  const revised = `// Revised declaration\n// ${unrelated} in unselected context\nexport const ${after} = 29\nexport const stable = 31\n`
  const companionContent = `// Companion declaration\n\n// Select only the identifier below\nexport const ${companion} = 59\n// ${unrelated} in another unselected line\n`
  const controlContent = `export const ${unrelated} = 83\n`
  writeFileSync(revisedPath, original)
  writeFileSync(companionPath, companionContent)
  writeFileSync(controlPath, controlContent)
  git('init', '-q', `--template=${emptyHooks}`)
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('add', '--', 'revision.ts', 'companion.ts', 'unselected.ts')
  git('commit', '-q', '-m', 'Synthetic reference baseline')
  const revision = git('rev-parse', 'HEAD')
  writeFileSync(revisedPath, revised)
  return {
    root, revision, before, after, companion, unrelated, revisedPath, companionPath,
    original,
    files: new Map([[revisedPath, revised], [companionPath, companionContent], [controlPath, controlContent]]),
    git,
  }
}
