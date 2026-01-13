/**
 * Prepare cloudflared binary for Windows x64 packaging
 *
 * Usage: node scripts/prepare-cloudflared-win-x64.mjs
 *
 * This script downloads Windows x64 version of cloudflared to node_modules/cloudflared/bin/
 * Solves architecture mismatch when building x64 package on ARM machines
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLOUDFLARED_DIR = path.resolve(__dirname, '../node_modules/cloudflared/bin')
const CLOUDFLARED_PATH = path.join(CLOUDFLARED_DIR, 'cloudflared.exe')
const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'

function download(url, to) {
  console.log(`Downloading ${url}`)
  // Use curl, which automatically reads system proxy environment variables
  execSync(`curl -L -o "${to}" "${url}"`, { stdio: 'inherit' })
  console.log(`Downloaded to ${to}`)
  return to
}

async function main() {
  console.log('=== Preparing cloudflared for Windows x64 ===\n')

  // Ensure directory exists
  if (!fs.existsSync(CLOUDFLARED_DIR)) {
    fs.mkdirSync(CLOUDFLARED_DIR, { recursive: true })
  }

  // Remove existing file if any
  if (fs.existsSync(CLOUDFLARED_PATH)) {
    fs.unlinkSync(CLOUDFLARED_PATH)
    console.log('Removed existing cloudflared.exe')
  }

  // Download
  await download(DOWNLOAD_URL, CLOUDFLARED_PATH)

  console.log('\n✅ Done! You can now run: npm run build:win-x64')
}

main().catch(err => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
