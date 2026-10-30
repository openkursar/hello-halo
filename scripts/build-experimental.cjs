'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { signingEnvironment } = require('./lib/mac-local-signing.cjs')
const { validateExperimentalProduct } = require('./lib/experimental-product.cjs')

try {
  if (process.platform !== 'darwin') throw new Error('This installer target requires macOS')
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some(arg => !['--arm64', '--x64'].includes(arg))) {
    throw new Error('Usage: npm run build:experimental -- [--arm64 | --x64]')
  }
  const arch = args[0]?.slice(2) || process.arch
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported architecture')
  const root = path.resolve(__dirname, '..')
  const env = {
    ...signingEnvironment(), CSC_IDENTITY_AUTO_DISCOVERY: 'false', HALO_MAC_SIGN_MODE: 'adhoc',
    HALO_REQUIRE_ENGINES: 'halo,codex,dsh',
  }
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'CSC_IDENTITY',
    'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete env[key]
  delete env.HALO_PRODUCT_SOURCE
  const run = (file, argv) => execFileSync(file, argv, { cwd: root, env, stdio: 'inherit' })
  run(process.execPath, ['scripts/prepare-experimental-product.mjs'])
  const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'))
  validateExperimentalProduct(product)
  env.HALO_PRODUCT_SOURCE = path.join(root, 'halo-local', 'product.experimental.json')
  run(process.execPath, ['scripts/prepare-binaries.mjs', '--platform', `mac-${arch}`])
  run('npm', ['run', 'build'])
  run(path.join(root, 'node_modules', '.bin', 'electron-builder'), [
    '--mac', `dmg:${arch}`, `zip:${arch}`, '--config', 'electron-builder.cjs',
    '-c.mac.identity=null', '-c.mac.notarize=false', '-c.directories.output=dist/experimental',
    '--publish', 'never',
  ])
  console.log(`[experimental] Installer ready in dist/experimental; version ${product.version}`)
} catch (error) {
  console.error(`[experimental] Build failed: ${error.message}`)
  process.exitCode = 1
}
