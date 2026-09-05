/**
 * Reusable memory lifecycle (snapshot, history scaffolding, session summary, compaction).
 * Three policies: automation (all steps), team (snapshot + compaction only), chat (none).
 * Lives here (not platform/memory) because compaction requires an LLM call.
 */

import type { MemoryService, MemoryCallerScope } from '../../../platform/memory'
import { buildMemorySnapshot, type MemorySnapshot } from '../../../platform/memory/snapshot'
import type { TriggerContext, AppRunResult } from '../types'
import { truncateUtf16Safe } from '../text-truncate'
import { query as agentSdkQuery } from '../../../services/agent/resolved-sdk'
import { getHeadlessElectronPath, getWorkingDir } from '../../../services/agent/helpers'
import { buildSdkEnv } from '../../../services/agent/sdk-config'
import type { ResolvedModelCapabilities } from '../../../services/agent/types'

// ── Prepare (turn start) ──

export interface MemoryPrepareOptions {
  /** Disabled for team turns (many turns per epoch would flood History). Default: true. */
  preInsertHistory?: boolean
}

export interface PreparedMemory {
  snapshot: MemorySnapshot
  runTimestamp: string
}

export async function prepareMemoryForTurn(
  scope: MemoryCallerScope,
  opts: MemoryPrepareOptions = {}
): Promise<PreparedMemory> {
  const snapshot = await buildMemorySnapshot(scope)
  const runTimestamp = formatRunTimestamp(new Date())

  if (opts.preInsertHistory !== false) {
    await preInsertHistoryHeading(snapshot.memoryFilePath, runTimestamp, snapshot.rawContent)
  }

  return { snapshot, runTimestamp }
}

// ── Finalize (turn end) ──

export interface MemoryFinalizeContext {
  appName: string
  runId: string
  trigger: TriggerContext
  outcome: AppRunResult['outcome']
  durationMs: number
  tokensUsed: number
  finalText: string
  escalation: boolean
  runTag: string
}

export interface CompactionCredentials {
  anthropicApiKey?: string
  anthropicBaseUrl?: string
  sdkModel: string
  /** Raw provider fields — decide which compaction path to take (#121 fork). */
  provider?: string
  oauthProvider?: string
  /** Delegated sources (e.g. Claude Code CLI) hold no key — routed via delegatedRoutingHeader instead. */
  delegatedAuth?: boolean
  delegatedRoutingHeader?: string
  capabilities?: ResolvedModelCapabilities
}

/** Injected so this module stays decoupled from InstalledApp / config. */
export type CompactionCredentialsProvider = () => Promise<CompactionCredentials>

export interface MemoryFinalizeOptions {
  saveSessionSummary?: boolean
  compact?: boolean
}

/** Best-effort: failures are logged, never re-thrown. */
export async function finalizeMemoryAfterTurn(
  memory: MemoryService,
  scope: MemoryCallerScope,
  ctx: MemoryFinalizeContext,
  credsProvider: CompactionCredentialsProvider,
  opts: MemoryFinalizeOptions = {}
): Promise<void> {
  if (opts.saveSessionSummary !== false) {
    await saveRunSessionSummary(memory, scope, ctx)
  }
  if (opts.compact !== false) {
    await checkAndCompactMemory(memory, scope, ctx.appName, ctx.runTag, credsProvider)
  }
}

// ── Session Summary ──

const MAX_SUMMARY_LENGTH = 2000

async function saveRunSessionSummary(
  memory: MemoryService,
  scope: MemoryCallerScope,
  ctx: MemoryFinalizeContext
): Promise<void> {
  if (ctx.outcome === 'noop') {
    console.log(`[Runtime][${ctx.runTag}] Skipping session summary (noop run)`)
    return
  }

  try {
    const summaryContent = buildSummaryContent(ctx)
    const slug = buildSummarySlug(ctx)

    await memory.saveSessionSummary(scope, 'app', { content: summaryContent, slug })
    console.log(`[Runtime][${ctx.runTag}] Session summary saved (slug=${slug})`)
  } catch (err) {
    console.error(`[Runtime][${ctx.runTag}] Failed to save session summary:`, err)
  }
}

function buildSummaryContent(ctx: MemoryFinalizeContext): string {
  const lines: string[] = []

  lines.push(`**App:** ${ctx.appName}`)
  lines.push(`**Trigger:** ${ctx.trigger.type}`)
  lines.push(`**Outcome:** ${ctx.outcome}`)
  lines.push(`**Duration:** ${ctx.durationMs}ms`)

  if (ctx.tokensUsed > 0) {
    lines.push(`**Tokens:** ${ctx.tokensUsed}`)
  }

  if (ctx.escalation) {
    lines.push(`**Escalation:** yes`)
  }

  if (ctx.finalText.trim()) {
    const truncated = ctx.finalText.length > MAX_SUMMARY_LENGTH
      ? truncateUtf16Safe(ctx.finalText, MAX_SUMMARY_LENGTH) + '\n\n*(truncated)*'
      : ctx.finalText
    lines.push('')
    lines.push('## Output')
    lines.push('')
    lines.push(truncated)
  }

  return lines.join('\n')
}

function buildSummarySlug(ctx: MemoryFinalizeContext): string {
  const prefix = ctx.outcome === 'error' ? 'error' : 'run'
  const appSlug = ctx.appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
  return `${prefix}-${appSlug}`
}

// ── Memory Compaction ──

const MAX_COMPACTION_INPUT_LENGTH = 50000

/** High ceiling so the model is never the truncation constraint (prompt guides length). */
const COMPACTION_MAX_TOKENS = 16384

const COMPACTION_MAX_RETRIES = 2

/**
 * Best-effort: failures are logged, never re-thrown. Exported for team turns,
 * which take this step alone — they inject a snapshot and let memory grow, but
 * write no per-run summary, so compaction is the only thing keeping memory.md
 * from crossing its size ceiling unbounded.
 */
export async function checkAndCompactMemory(
  memory: MemoryService,
  scope: MemoryCallerScope,
  appName: string,
  runTag: string,
  credsProvider: CompactionCredentialsProvider
): Promise<void> {
  try {
    const needsCompaction = await memory.needsCompaction(scope, 'app')
    if (!needsCompaction) return

    console.log(`[Runtime][${runTag}] Memory compaction triggered (app="${appName}")`)

    const currentContent = await memory.read(scope, { scope: 'app', mode: 'full' })
    if (!currentContent) {
      console.log(`[Runtime][${runTag}] Memory file empty/missing, skipping compaction`)
      return
    }

    const { archived, needsSummary } = await memory.compact(scope, 'app')
    if (!needsSummary) {
      console.log(`[Runtime][${runTag}] Compaction complete, no summary needed`)
      return
    }

    console.log(`[Runtime][${runTag}] Memory archived to ${archived}, generating LLM summary...`)

    const summary = await generateCompactionSummary(
      currentContent,
      appName,
      scope,
      runTag,
      credsProvider
    )

    await memory.write(scope, {
      scope: 'app',
      content: summary,
      mode: 'replace'
    })

    console.log(
      `[Runtime][${runTag}] Memory compacted: ` +
      `old=${(currentContent.length / 1024).toFixed(1)}KB → ` +
      `new=${(summary.length / 1024).toFixed(1)}KB`
    )
  } catch (err) {
    console.error(`[Runtime][${runTag}] Memory compaction failed:`, err)
  }
}

/** Both `# now` and `# History` must exist or downstream functions produce corrupt state. */
function isValidCompaction(content: string): boolean {
  return /^# now\s*$/m.test(content) && /^# History\s*$/m.test(content)
}

function buildCompactionPrompt(content: string, appName: string): string {
  return (
    `You are compacting the memory file for an automation app called "${appName}".\n\n` +
    `## Current Memory Content\n\n${content}\n\n` +
    `## Output Format\n\n` +
    `You MUST produce output in exactly this structure:\n\n` +
    '```\n' +
    `# now\n\n` +
    `## State | one-line summary\n` +
    `(current state values only — drop stale/superseded entries)\n\n` +
    `## EntityName\n` +
    `(active entities only — merge duplicates, drop entities not seen recently)\n\n` +
    `## Patterns\n` +
    `(proven patterns only — drop one-off observations)\n\n` +
    `## Errors\n` +
    `(unresolved errors only — drop resolved ones)\n\n` +
    `# History\n\n` +
    `## YYYY-MM-DD-HHmm | summary\n` +
    `(keep the most recent ~10 entries, drop older ones)\n` +
    '```\n\n' +
    `## Rules\n\n` +
    `- Output ONLY the compacted markdown, no explanations or commentary\n` +
    `- Every entry in \`# now\` must be current and actionable\n` +
    `- Aim for roughly 60–120 lines total\n` +
    `- Both \`# now\` and \`# History\` H1 headings are MANDATORY — never omit them\n` +
    `- Preserve the original entity names and data values exactly\n` +
    `- Older History entries are already archived in memory/run/ files, safe to drop`
  )
}

/** Abort timeout for the one-shot agent-SDK compaction query */
const COMPACTION_AGENT_SDK_TIMEOUT_MS = 120_000

/**
 * Only Claude locks its OAuth tokens to first-party clients (api.anthropic.com
 * rejects bare @anthropic-ai/sdk calls with 403 even with a valid token), so
 * only Claude OAuth compaction must go through the agent SDK's cli.js
 * subprocess, which carries Anthropic's request signing. Other OAuth providers
 * ride the same local OpenAI-compat router as their normal chat turns, which
 * is not first-party-locked (#121).
 *
 * Delegated sources join the first-party bucket too: they hold no key at all,
 * and the CLI subprocess is their only credential carrier — a raw SDK call
 * would reach the router with an empty key and no routing header, fail, and
 * silently fall back to the heuristic compaction summary.
 */
export function providerRequiresFirstPartyClient(
  provider?: string,
  oauthProvider?: string,
  delegatedAuth?: boolean
): boolean {
  return delegatedAuth || (provider === 'oauth' && oauthProvider === 'claude')
}

/**
 * Provider fork (#121): first-party-locked providers (Claude OAuth) reject
 * bare @anthropic-ai/sdk calls with 403, so they go through the agent SDK's
 * cli.js subprocess instead. All other providers keep the raw SDK path.
 */
async function generateCompactionSummary(
  content: string,
  appName: string,
  scope: MemoryCallerScope,
  runTag: string,
  credsProvider: CompactionCredentialsProvider
): Promise<string> {
  try {
    const resolved = await credsProvider()
    if (providerRequiresFirstPartyClient(resolved.provider, resolved.oauthProvider, resolved.delegatedAuth)) {
      return await generateCompactionViaAgentSdk(content, appName, scope, resolved, runTag)
    }
    return await generateCompactionViaRawSdk(content, appName, resolved, runTag)
  } catch (err) {
    console.error(`[Runtime][${runTag}] LLM compaction failed, using fallback:`, err)
    return buildFallbackCompactionSummary(content)
  }
}

/**
 * Compaction via a one-shot agent SDK query. The resolved router credentials
 * are the same ones the run's main session uses, so the cli.js subprocess
 * path carries whatever signing the provider requires.
 *
 * No retry loop here: the prompt already mandates the H1 structure, and on
 * invalid or failed output the caller-facing semantics (fallback below)
 * keep the archived memory recoverable.
 */
async function generateCompactionViaAgentSdk(
  content: string,
  appName: string,
  scope: MemoryCallerScope,
  resolved: CompactionCredentials,
  runTag: string
): Promise<string> {
  const truncatedContent = content.length > MAX_COMPACTION_INPUT_LENGTH
    ? truncateUtf16Safe(content, MAX_COMPACTION_INPUT_LENGTH) + '\n\n... (truncated)'
    : content

  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), COMPACTION_AGENT_SDK_TIMEOUT_MS)

  try {
    const queryIterator = agentSdkQuery({
      prompt: buildCompactionPrompt(truncatedContent, appName),
      options: {
        model: resolved.sdkModel,
        anthropicBaseUrl: resolved.anthropicBaseUrl,
        cwd: getWorkingDir(scope.spaceId),
        executable: getHeadlessElectronPath(),
        executableArgs: ['--no-warnings'],
        // Same env builder as regular sessions: it routes delegated sources via
        // ANTHROPIC_CUSTOM_HEADERS — never ANTHROPIC_API_KEY, which would
        // override the CLI's own credential — and pins CLAUDE_CONFIG_DIR,
        // where the delegated CLI looks up that credential.
        env: buildSdkEnv({
          anthropicApiKey: resolved.anthropicApiKey ?? '',
          anthropicBaseUrl: resolved.anthropicBaseUrl ?? '',
          delegatedRoutingHeader: resolved.delegatedRoutingHeader,
          capabilities: resolved.capabilities,
        }),
        permissionMode: 'bypassPermissions',
        abortController,
        maxTurns: 1,
      } as any,
    })

    let lastOutput = ''
    for await (const msg of queryIterator) {
      if (msg.type === 'assistant') {
        const blocks = (msg as any).message?.content
        if (Array.isArray(blocks)) {
          lastOutput += blocks
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('')
        }
      } else if (msg.type === 'result') {
        const resultText = (msg as any).result ?? (msg as any).message?.result ?? ''
        if (typeof resultText === 'string' && resultText.length > lastOutput.length) {
          lastOutput = resultText
        }
        break
      }
    }

    if (lastOutput.trim().length === 0) {
      console.warn(`[Runtime][${runTag}] Agent-SDK compaction returned no usable output, using fallback`)
      return buildFallbackCompactionSummary(content)
    }
    if (!isValidCompaction(lastOutput)) {
      console.warn(
        `[Runtime][${runTag}] Agent-SDK compaction output missing required headings, using fallback`
      )
      return buildFallbackCompactionSummary(content)
    }
    return lastOutput
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Compaction via the raw @anthropic-ai/sdk client with format validation and
 * multi-turn retry. Works with all non-locked provider types (Anthropic API
 * key, OpenAI-compat). After all retries, keeps the last LLM output; only
 * falls back to code-based extraction when nothing usable was produced.
 */
async function generateCompactionViaRawSdk(
  content: string,
  appName: string,
  resolved: CompactionCredentials,
  runTag: string
): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  const truncatedContent = content.length > MAX_COMPACTION_INPUT_LENGTH
    ? truncateUtf16Safe(content, MAX_COMPACTION_INPUT_LENGTH) + '\n\n... (truncated)'
    : content

  const client = new Anthropic({
    apiKey: resolved.anthropicApiKey,
    baseURL: resolved.anthropicBaseUrl,
  })

  const prompt = buildCompactionPrompt(truncatedContent, appName)

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: prompt },
  ]

  let lastOutput = ''

  for (let attempt = 0; attempt <= COMPACTION_MAX_RETRIES; attempt++) {
    const response = await client.messages.create({
      model: resolved.sdkModel,
      max_tokens: COMPACTION_MAX_TOKENS,
      messages,
    })

    const output = response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')

    if (output.trim().length === 0) {
      console.warn(`[Runtime][${runTag}] Compaction attempt ${attempt + 1}: LLM returned empty output`)
      break
    }

    lastOutput = output

    if (isValidCompaction(output)) {
      if (attempt > 0) {
        console.log(`[Runtime][${runTag}] Compaction succeeded on retry ${attempt}`)
      }
      return output
    }

    console.warn(
      `[Runtime][${runTag}] Compaction attempt ${attempt + 1}: ` +
      `output missing required headings (has # now: ${/^# now\s*$/m.test(output)}, ` +
      `has # History: ${/^# History\s*$/m.test(output)})`
    )

    if (attempt < COMPACTION_MAX_RETRIES) {
      messages.push({ role: 'assistant', content: output })
      messages.push({
        role: 'user',
        content:
          'Your output is missing the required H1 headings. ' +
          'The compacted memory MUST contain both `# now` and `# History` as H1 headings ' +
          '(lines starting with exactly `# now` and `# History`). ' +
          'Please output the corrected compacted memory.',
      })
    }
  }

  if (lastOutput.trim().length > 0) {
    console.warn(
      `[Runtime][${runTag}] Compaction retries exhausted, ` +
      `keeping last LLM output (${lastOutput.length} chars)`
    )
    return lastOutput
  }

  console.warn(`[Runtime][${runTag}] LLM returned no usable output, using fallback`)
  return buildFallbackCompactionSummary(content)
}

/** Extracts `# now` (first 50 lines) and `# History` (last 10 entries) when LLM is unavailable. */
function buildFallbackCompactionSummary(content: string): string {
  const lines = content.split('\n')

  let nowStart = -1
  let nowEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^# now\s*$/.test(lines[i])) {
      nowStart = i
    } else if (nowStart >= 0 && /^# [^#]/.test(lines[i]) && !/^# now\s*$/.test(lines[i])) {
      nowEnd = i
      break
    }
  }

  let nowLines: string[]
  if (nowStart >= 0) {
    const sectionLines = lines.slice(nowStart, nowEnd)
    nowLines = sectionLines.slice(0, 51) // # now heading + up to 50 lines
  } else {
    nowLines = ['# now', '', '## State']
  }

  let historyStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^# History\s*$/.test(lines[i])) {
      historyStart = i
      break
    }
  }

  const historyEntries: string[][] = []
  if (historyStart >= 0) {
    let currentEntry: string[] = []
    for (let i = historyStart + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) {
        if (currentEntry.length > 0) {
          historyEntries.push(currentEntry)
        }
        currentEntry = [lines[i]]
      } else if (currentEntry.length > 0) {
        currentEntry.push(lines[i])
      }
    }
    if (currentEntry.length > 0) {
      historyEntries.push(currentEntry)
    }
  }

  const recentEntries = historyEntries.slice(0, 10)

  const parts = [
    '<!-- Compacted by system (LLM unavailable) -->',
    '',
    ...nowLines,
    '',
    '# History',
    '',
    ...recentEntries.flatMap(entry => [...entry, '']),
  ]

  return parts.join('\n').trimEnd() + '\n'
}

// ── History Heading Pre-insertion ──

export function formatRunTimestamp(date: Date): string {
  const y = date.getFullYear()
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${d}-${h}${min}`
}

async function preInsertHistoryHeading(
  memoryFilePath: string,
  timestamp: string,
  preReadContent: string | null
): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises')
  const { dirname } = await import('path')
  const { existsSync } = await import('fs')

  const dir = dirname(memoryFilePath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  const heading = `## ${timestamp}`

  if (preReadContent === null) {
    const skeleton = `# now\n\n## State\n\n# History\n\n${heading}\n`
    await writeFile(memoryFilePath, skeleton, 'utf-8')
    return
  }

  const content = preReadContent

  const historyMatch = content.match(/^# History\s*$/m)
  if (historyMatch && historyMatch.index !== undefined) {
    const insertPos = historyMatch.index + historyMatch[0].length
    const before = content.slice(0, insertPos)
    const after = content.slice(insertPos)
    const newContent = before + `\n\n${heading}` + after
    await writeFile(memoryFilePath, newContent, 'utf-8')
  } else {
    const appendContent = content.trimEnd() + `\n\n# History\n\n${heading}\n`
    await writeFile(memoryFilePath, appendContent, 'utf-8')
  }
}
