#!/usr/bin/env node
/**
 * Scaffold a new enterprise vendor overlay under halo-local/<vendor>/.
 *
 * Usage (from hello-halo repo root):
 *   node scripts/init-enterprise.mjs <vendor-name>
 *
 * Example:
 *   node scripts/init-enterprise.mjs acme
 *
 * What it creates:
 *   halo-local/<vendor>/
 *     ├── product.<vendor>.json          brand / AI gateway / login / security
 *     ├── electron-builder.<vendor>.cjs  electron-builder overlay
 *     ├── scripts/build.sh               one-shot build
 *     └── README.md
 *
 * This script is documented as the "fast path" in
 * docs/enterprise-deployment.zh.md. The file contents below MUST stay
 * identical to the "manual copy-paste" path documented there — any
 * change to one must be mirrored in the other so users who pick either
 * route get the exact same output.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// ----------------------------------------------------------------------------
// Args
// ----------------------------------------------------------------------------

const vendor = process.argv[2]

if (!vendor) {
  console.error('Usage: node scripts/init-enterprise.mjs <vendor-name>')
  console.error('Example: node scripts/init-enterprise.mjs acme')
  process.exit(1)
}

if (!/^[a-z][a-z0-9-]{1,30}$/.test(vendor)) {
  console.error(`[init-enterprise] Invalid vendor name: "${vendor}"`)
  console.error('Vendor name must match /^[a-z][a-z0-9-]{1,30}$/ — lowercase, digits, hyphens; start with a letter; max 31 chars.')
  process.exit(1)
}

// ----------------------------------------------------------------------------
// Preconditions
// ----------------------------------------------------------------------------

const HALO_LOCAL = join(REPO_ROOT, 'halo-local')
if (!existsSync(HALO_LOCAL)) {
  console.error('[init-enterprise] halo-local/ does not exist.')
  console.error('')
  console.error('Run the one-time setup from docs/enterprise-deployment.zh.md §2 first:')
  console.error('')
  console.error('  mkdir halo-local && cd halo-local')
  console.error('  git init')
  console.error(`  printf "node_modules/\\n${vendor}/\\n" > .gitignore`)
  console.error('  cd ..')
  console.error('')
  process.exit(1)
}

const VENDOR_ROOT = join(HALO_LOCAL, vendor)
if (existsSync(VENDOR_ROOT)) {
  console.error(`[init-enterprise] ${VENDOR_ROOT} already exists. Refusing to overwrite.`)
  console.error('Delete it manually if you really want to re-scaffold.')
  process.exit(1)
}

// ----------------------------------------------------------------------------
// Template rendering
// ----------------------------------------------------------------------------

// Capitalized form used in productName / display names: "acme" → "Acme".
const Vendor = vendor.charAt(0).toUpperCase() + vendor.slice(1)

const productJson = {
  $schema: '../../../product.schema.json',
  name: `Halo ${Vendor}`,
  dataFolderName: `halo-${vendor}`,
  version: '1.0.0',
  updateConfig: {
    provider: 'generic',
    url: `https://release.${vendor}.intra/halo/`,
  },
  authProviders: [
    {
      type: 'preset-api',
      displayName: { en: `${Vendor} AI`, 'zh-CN': `${Vendor} AI 网关` },
      description: {
        en: 'Internal AI gateway, just enter your API key',
        'zh-CN': '公司内部 AI 网关，输入 API Key 即可',
      },
      icon: 'key-round',
      iconBgColor: '#6366f1',
      recommended: true,
      enabled: true,
      preset: {
        baseUrl: `https://ai-gateway.${vendor}.intra/v1`,
        apiType: 'chat_completions',
        modelsPath: '/models',
        fallbackModels: [
          { id: 'gpt-4', name: 'GPT-4' },
          { id: 'claude-sonnet', name: 'Claude Sonnet' },
        ],
        docs: {
          url: `https://wiki.${vendor}.intra/ai-gateway`,
          label: { en: 'How to apply for an API key?', 'zh-CN': '如何申请 API Key？' },
        },
      },
    },
  ],
  security: {
    tunnelSafe: true,
    credentialAtRestSafe: true,
    remoteMcpSafe: true,
    mcpCommandBlacklist: ['bash', 'sh', 'zsh', 'powershell', 'cmd'],
  },
  browserPolicy: {
    mode: 'allowlist',
    allowlist: [
      `*.${vendor}.com`,
      `*.${vendor}.intra`,
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
    ],
  },
}

const electronBuilderCjs = `/**
 * ${Vendor} enterprise electron-builder overlay.
 *
 * Reads hello-halo public package.json#build as base, does not modify
 * it, only appends what ${Vendor} needs on top.
 *
 * Usage (from hello-halo repo root):
 *   electron-builder --mac --config halo-local/${vendor}/electron-builder.${vendor}.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

function loadBaseConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'))
  if (!pkg.build) throw new Error('[${vendor}] hello-halo package.json has no "build" section')
  return JSON.parse(JSON.stringify(pkg.build))
}

const base = loadBaseConfig()

module.exports = {
  ...base,
  // Never publish to a public registry — enterprise artifacts ship via internal channels.
  publish: null,
  // If you later add a private Provider compiled output, append its glob here:
  //   files: [...(base.files ?? []), 'halo-local/${vendor}/build/dist/**/*'],
}
`

const buildSh = `#!/bin/bash
# ${Vendor} enterprise build script.
#
# Usage (from hello-halo repo root):
#   bash halo-local/${vendor}/scripts/build.sh [--mac] [--win] [--linux]
#
# No platform argument = current platform only.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELLO_HALO_ROOT="$(cd "$VENDOR_ROOT/../.." && pwd)"
VENDOR_NAME="$(basename "$VENDOR_ROOT")"
CONFIG_PATH="halo-local/\${VENDOR_NAME}/electron-builder.\${VENDOR_NAME}.cjs"
PRODUCT_PATH="halo-local/\${VENDOR_NAME}/product.\${VENDOR_NAME}.json"

cd "$HELLO_HALO_ROOT"

# 1. Swap in the enterprise product.json (auto-restored on exit)
[ -f product.json ] && cp product.json product.json.bak
cp "$PRODUCT_PATH" product.json
trap '[ -f product.json.bak ] && mv product.json.bak product.json || rm -f product.json' EXIT

# 2. Compile the app
npm run build

# 3. Package (no publish)
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # mainland mirror
export CSC_IDENTITY_AUTO_DISCOVERY=false                         # skip code signing

PRODUCT_NAME="Halo-${Vendor}"
APP_ID="com.${vendor}.halo"

PLATFORMS="$@"
[ -z "$PLATFORMS" ] && PLATFORMS="--mac"

npx electron-builder $PLATFORMS \\
  --config "$CONFIG_PATH" \\
  -c.productName="$PRODUCT_NAME" \\
  -c.appId="$APP_ID"

echo ""
echo "Build done. Artifacts:"
ls -la dist/ | grep -i "${vendor}" || ls -la dist/
`

const readmeMd = `# Halo ${Vendor}

${Vendor} private build of Halo.

## Build

\`\`\`bash
cd <hello-halo repo root>
bash halo-local/${vendor}/scripts/build.sh --mac
\`\`\`

Artifacts land in \`hello-halo/dist/Halo-${Vendor}-*.dmg\`.

## Configure

- Brand, AI gateway, login, security: edit \`product.${vendor}.json\`
- Packaging rules: edit \`electron-builder.${vendor}.cjs\`

See the main guide: [docs/enterprise-deployment.zh.md](../../docs/enterprise-deployment.zh.md)
`

// ----------------------------------------------------------------------------
// Write files
// ----------------------------------------------------------------------------

mkdirSync(VENDOR_ROOT, { recursive: true })
mkdirSync(join(VENDOR_ROOT, 'scripts'), { recursive: true })

const files = [
  [`product.${vendor}.json`, JSON.stringify(productJson, null, 2) + '\n'],
  [`electron-builder.${vendor}.cjs`, electronBuilderCjs],
  [join('scripts', 'build.sh'), buildSh],
  ['README.md', readmeMd],
]

for (const [rel, content] of files) {
  const abs = join(VENDOR_ROOT, rel)
  writeFileSync(abs, content)
  if (rel.endsWith('.sh')) chmodSync(abs, 0o755)
  console.log(`  created  halo-local/${vendor}/${rel}`)
}

// ----------------------------------------------------------------------------
// git init the vendor repo (best-effort; ignore failures so the script
// still succeeds in environments without git)
// ----------------------------------------------------------------------------

try {
  execSync('git init -q', { cwd: VENDOR_ROOT })
  writeFileSync(join(VENDOR_ROOT, '.gitignore'), 'node_modules/\nbuild/dist/\n')
  console.log(`  git init halo-local/${vendor}/`)
} catch {
  // git not installed or already initialized — not fatal
}

// ----------------------------------------------------------------------------
// Next steps
// ----------------------------------------------------------------------------

console.log('')
console.log(`Scaffolded enterprise overlay at halo-local/${vendor}/`)
console.log('')
console.log('Next:')
console.log(`  1. Edit halo-local/${vendor}/product.${vendor}.json — fill in your real AI gateway URL and brand`)
console.log(`  2. Build:  bash halo-local/${vendor}/scripts/build.sh --mac`)
console.log(`  3. Find your dmg in dist/Halo-${Vendor}-*.dmg`)
console.log('')
console.log('Full guide: docs/enterprise-deployment.zh.md')
