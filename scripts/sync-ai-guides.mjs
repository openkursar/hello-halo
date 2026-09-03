#!/usr/bin/env node
/**
 * sync-ai-guides.mjs — refresh the bundled AI guide snapshot
 *
 * The AI guides are official Halo documentation written for agent consumption
 * (raw markdown, fetched at runtime by the `read_halo_doc` tool). Their source
 * of truth is the documentation site repository, where they are published as
 * static assets:
 *
 *   halo-website/docs-src/public/ai-guides/**.md
 *     -> https://<docs host>/docs/ai-guides/**.md
 *
 * Publishing there is what makes a content fix reach users without shipping a
 * client. `resources/ai-guides/` is only the offline floor: the copy shipped
 * inside the app so `read_halo_doc` still returns complete content when the
 * docs host is unreachable. Refresh it before cutting a release; a stale
 * snapshot degrades offline quality but never breaks the online path.
 *
 * Usage:
 *   node scripts/sync-ai-guides.mjs                       # default source path
 *   node scripts/sync-ai-guides.mjs /abs/path/ai-guides   # explicit source
 *   HALO_AI_GUIDES_SOURCE=/abs/path node scripts/sync-ai-guides.mjs
 *
 * Exit codes:
 *   0 — snapshot written
 *   1 — source missing or content violates the packaging rules
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const TARGET_DIR = join(PROJECT_ROOT, 'resources', 'ai-guides')
const DEFAULT_SOURCE = resolve(PROJECT_ROOT, '..', 'halo-website', 'docs-src', 'public', 'ai-guides')

/** Entry document the client hard-codes; renaming it would strand every client. */
const REQUIRED_ENTRY = join('create-digital-human', 'SKILL.md')
/** Mirrors the runtime read cap in services/official-docs.service.ts. */
const MAX_DOC_BYTES = 512 * 1024
/** Authoring rule: split by topic instead of shipping one oversized document. */
const SOFT_MAX_LINES = 500

const log = {
  info: (m) => console.log(`[sync-ai-guides] ${m}`),
  warn: (m) => console.warn(`[sync-ai-guides] WARN ${m}`),
  err: (m) => console.error(`[sync-ai-guides] ERROR ${m}`),
}

function resolveSource() {
  const raw = process.argv[2] || process.env.HALO_AI_GUIDES_SOURCE || DEFAULT_SOURCE
  return isAbsolute(raw) ? raw : resolve(PROJECT_ROOT, raw)
}

function collectMarkdown(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative(root, abs))
    }
  }
  walk(root)
  return files.sort()
}

function main() {
  const source = resolveSource()

  if (!existsSync(source) || !statSync(source).isDirectory()) {
    log.err(`source directory not found: ${source}`)
    log.err('Pass the path explicitly or set HALO_AI_GUIDES_SOURCE.')
    process.exit(1)
  }

  const files = collectMarkdown(source)
  if (files.length === 0) {
    log.err(`no .md files under ${source}`)
    process.exit(1)
  }

  if (!files.includes(REQUIRED_ENTRY)) {
    log.err(`missing required entry document: ${REQUIRED_ENTRY}`)
    log.err('The client hard-codes this path; it must never be renamed or removed.')
    process.exit(1)
  }

  for (const rel of files) {
    const content = readFileSync(join(source, rel), 'utf-8')
    const bytes = Buffer.byteLength(content, 'utf-8')
    if (bytes > MAX_DOC_BYTES) {
      log.err(`${rel} is ${bytes} bytes, over the ${MAX_DOC_BYTES}-byte runtime read cap. Split it.`)
      process.exit(1)
    }
    const lines = content.split('\n').length
    if (lines > SOFT_MAX_LINES) {
      log.warn(`${rel} has ${lines} lines (soft limit ${SOFT_MAX_LINES}) — consider splitting by topic.`)
    }
  }

  const staging = `${TARGET_DIR}.tmp`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  for (const rel of files) {
    const dest = join(staging, rel)
    mkdirSync(resolve(dest, '..'), { recursive: true })
    cpSync(join(source, rel), dest)
  }

  writeFileSync(
    join(staging, 'SNAPSHOT.json'),
    JSON.stringify({ syncedAt: new Date().toISOString().slice(0, 10), source, files }, null, 2) + '\n'
  )

  rmSync(TARGET_DIR, { recursive: true, force: true })
  cpSync(staging, TARGET_DIR, { recursive: true })
  rmSync(staging, { recursive: true, force: true })

  log.info(`snapshot written: ${files.length} document(s) -> ${relative(PROJECT_ROOT, TARGET_DIR)}`)
  for (const rel of files) log.info(`  ${rel}`)
}

main()
