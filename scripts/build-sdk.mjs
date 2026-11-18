import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The SDK is a path dependency: npm links it but neither installs its own dev
// toolchain nor builds it, and the host loads its compiled entries.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdk = path.join(root, 'src/sdk/halo-sdk')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args) {
  const result = spawnSync(npm, args, { cwd: sdk, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error || result.status !== 0) throw new Error(`SDK "npm ${args.join(' ')}" failed`)
}

const force = process.argv.includes('--force')

if (!fs.existsSync(path.join(sdk, 'package.json'))) {
  console.log('  - SDK build skipped (src/sdk/halo-sdk is absent)')
} else {
  const check = force ? null : spawnSync(process.execPath, ['scripts/build.mjs', '--check-distribution'], { cwd: sdk, encoding: 'utf8' })
  if (check?.error) throw check.error
  if (check?.status === 0) {
    console.log('  - SDK build reused (run `npm run build:sdk` to rebuild)')
  } else {
    if (check) console.log(`  - SDK distribution needs a rebuild: ${(check.stdout || check.stderr).trim()}`)
    if (!fs.existsSync(path.join(sdk, 'node_modules/typescript'))) run(['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    run(['run', force ? 'build' : 'build:if-missing'])
  }
}
