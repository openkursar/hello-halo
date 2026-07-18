/**
 * Offline wiki builder (compounding curator) — NOT on the default ingest path.
 *
 * Kept for a future optional "build a reading map" feature: a headless agent
 * folds each source into a compounding markdown wiki under wiki/. The live
 * knowledge base uses agentic search over text/ (see ingest.ts); this module is
 * intentionally unwired and only runs when explicitly invoked.
 */

import { join, sep } from 'path'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { getConfig } from '../../foundation/config.service'
import { getApiCredentials, getHeadlessElectronPath } from '../agent/helpers'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from '../agent/sdk-config'
import { query } from '../agent/resolved-sdk'
import type { IngestHashesV1 } from '../../../shared/types/tlon'
import { getKBSchemaPath, getKBWikiDir } from './paths'
import {
  getKB,
  readHashes,
  writeHashes,
  collectIngestCandidates,
  sha256,
} from './service'
import { extractText } from './extract'
import { buildCuratorSystemPrompt, buildCuratorUserMessage } from './defaults'

/** Fold every changed source of a KB into its compounding wiki (sequential). */
export async function buildWikiForKB(kbId: string): Promise<void> {
  const kb = getKB(kbId)
  if (!kb) return
  const wikiDir = getKBWikiDir(kbId)

  for (const job of collectIngestCandidates(kbId)) {
    let buf: Buffer
    try {
      buf = readFileSync(job.absolutePath)
    } catch {
      continue
    }
    let fileContent: string
    try {
      fileContent = await extractText(job.absolutePath, buf)
    } catch {
      continue
    }
    if (!fileContent.trim()) continue

    const before = snapshotWikiMtimes(wikiDir)
    await runCuratorAgent(kbId, job.sourcePath, fileContent, wikiDir)
    const affected = changedPages(before, snapshotWikiMtimes(wikiDir))

    const hashes: IngestHashesV1 = readHashes(kbId)
    hashes.files[job.sourcePath] = {
      hash: sha256(buf),
      ingestedAt: new Date().toISOString(),
      wikiPages: affected,
    }
    writeHashes(kbId, hashes)
  }
}

async function runCuratorAgent(
  kbId: string,
  sourcePath: string,
  fileContent: string,
  wikiDir: string
): Promise<void> {
  const config = getConfig()
  const credentials = await getApiCredentials(config)
  const resolved = await resolveCredentialsForSdk(credentials)
  const electronPath = getHeadlessElectronPath()
  const schema = existsSync(getKBSchemaPath(kbId))
    ? readFileSync(getKBSchemaPath(kbId), 'utf-8')
    : ''

  const sdkOptions = buildBaseSdkOptions({
    credentials: resolved,
    workDir: wikiDir,
    electronPath,
    spaceId: `tlon-ingest:${kbId}`,
    conversationId: `tlon-ingest-${uuidv4()}`,
    mcpServers: null,
    maxTurns: 60,
    promptProfile: config.agent?.promptProfile,
    configDirMode: config.agent?.configDirMode,
    customConfigDir: config.agent?.customConfigDir,
    aiBrowserEnabled: false,
    digitalHumansEnabled: false,
  })
  sdkOptions.systemPrompt = buildCuratorSystemPrompt(schema)
  sdkOptions.allowedTools = ['Read', 'Write', 'Edit', 'Grep', 'Glob']
  sdkOptions.disallowedTools = ['Bash', 'Skill', 'Task', 'WebSearch', 'WebFetch', 'TodoWrite']
  sdkOptions.maxThinkingTokens = 0

  const userMessage = buildCuratorUserMessage(sourcePath, fileContent)

  let resultError: string | null = null
  for await (const msg of query({ prompt: userMessage, options: sdkOptions })) {
    const m = msg as { type?: string; subtype?: string; is_error?: boolean }
    if (m?.type === 'result') {
      if (m.is_error) resultError = m.subtype || 'agent error'
      break
    }
  }
  if (resultError) {
    throw new Error(`Curator agent failed: ${resultError}`)
  }
}

/** Map of wiki-relative .md path -> mtime (ms), to detect changed pages. */
function snapshotWikiMtimes(wikiDir: string): Map<string, number> {
  const out = new Map<string, number>()
  if (!existsSync(wikiDir)) return out
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop() as string
    let entries: string[]
    try { entries = readdirSync(join(wikiDir, rel)) } catch { continue }
    for (const name of entries) {
      const childRel = rel ? join(rel, name) : name
      let st
      try { st = statSync(join(wikiDir, childRel)) } catch { continue }
      if (st.isDirectory()) stack.push(childRel)
      else if (st.isFile() && childRel.toLowerCase().endsWith('.md')) {
        out.set(childRel.split(sep).join('/'), st.mtimeMs)
      }
    }
  }
  return out
}

/** Pages added or modified between two mtime snapshots. */
function changedPages(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = []
  after.forEach((mtime, path) => {
    const prev = before.get(path)
    if (prev === undefined || mtime > prev) changed.push(path)
  })
  return changed.sort()
}
