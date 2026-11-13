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

if (!fs.existsSync(path.join(sdk, 'package.json'))) {
  console.log('  - SDK build skipped (src/sdk/halo-sdk is absent)')
} else if (fs.existsSync(path.join(sdk, `dist/native/halo-sdk.${process.platform}-${process.arch}.node`)) && !process.argv.includes('--force')) {
  console.log('  - SDK build reused (run `npm run build:sdk` to rebuild)')
} else {
  if (!fs.existsSync(path.join(sdk, 'node_modules/typescript'))) run(['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
  run(['run', 'build'])
}
