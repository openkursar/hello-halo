import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const lifecycle = process.argv[2] === '--if-checkout'
// Every worktree shares this hook; a branch without the checker, or a machine without Node, commits unchecked.
const hook = `#!/bin/sh
[ -f scripts/commit-check/check.mjs ] || exit 0
command -v node >/dev/null 2>&1 || { echo 'Disclosure check skipped: Node.js not found.' >&2; exit 0; }
exec node scripts/commit-check/check.mjs "$1"
`

function git(...args) {
  const run = spawnSync('git', ['rev-parse', '--path-format=absolute', ...args], { cwd: root, encoding: 'utf8' })
  if (run.status !== 0) throw new Error('Cannot resolve the Git checkout. Nothing was installed.')
  return run.stdout.trimEnd()
}

function install() {
  if (lifecycle && !existsSync(join(root, '.git'))) return
  if (realpathSync(git('--show-toplevel')) !== realpathSync(root)) throw new Error('Install from the owning repository, not a dependency or parent repository.')
  const common = realpathSync(git('--git-common-dir'))
  const dir = git('--git-path', 'hooks')
  if (resolve(dir) !== join(common, 'hooks')) throw new Error('A custom core.hooksPath is active, so nothing was installed. Call the check from your own commit-msg hook; see scripts/commit-check/README.md.')
  mkdirSync(dir, { recursive: true })
  if (realpathSync(dir) !== join(common, 'hooks')) throw new Error('The hooks directory is redirected. Nothing was installed.')
  const file = join(dir, 'commit-msg')
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat) writeFileSync(file, hook, { flag: 'wx', mode: 0o755 })
  else if (!stat.isFile() || readFileSync(file, 'utf8') !== hook) throw new Error('An existing commit-msg hook was kept. Call the check from it; see scripts/commit-check/README.md.')
  else accessSync(file, constants.X_OK)
  if (!lifecycle) console.log('Disclosure check active: commit-msg hook installed.')
}

try {
  install()
} catch (error) {
  // System errors can include private paths. Only emit our own diagnostics.
  console.error(`Disclosure hook installation not complete: ${error.code ? 'check the hook file and its permissions; nothing was replaced.' : error.message}`)
  if (!lifecycle) process.exitCode = 1
}
