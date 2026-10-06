/**
 * A digital human's memory around one turn: load it at the start, record the
 * run and request consolidation at the end, and the boundaries its file tools
 * are held to throughout. The owner's controls live in memory-control.ts.
 *
 * Three policies: automation runs take every step; team and chat turns load
 * memory and request consolidation but write no run record.
 */

import { join } from 'path'
import {
  resolveMemoryLayout,
  buildMemorySnapshot,
  insertHistoryHeading,
  ensureMemoryFile,
  formatTimestamp,
  formatMemoryUsage,
  scanTopics,
  memoryContentPaths,
  type MemoryService,
  type MemoryCallerScope,
  type MemorySnapshot,
  type MemoryTrackedItem,
  type MemoryPromptOptions,
  type MemoryWriteGuardConfig,
  type TopicsTree,
  type MemoryLayout,
} from '../../../platform/memory'
import {
  resolveMemorySettings,
  type MemorySettings,
  type ResolvedMemorySettings,
} from '../../../../shared/types/memory'
import {
  requestConsolidation,
  type ConsolidationRequest,
} from '../../../services/memory-consolidation'
import { isSpaceMemoryEnabled } from '../../../services/space.service'
import type { ResolvedSdkCredentials } from '../../../services/agent/sdk-config'
import type { AppSpec } from '../../spec'
import { getTeamStore } from '../../team'
import type { TriggerContext, AppRunResult } from '../types'
import { truncateUtf16Safe } from '../text-truncate'
import type { TurnFileAccess } from '../turn-file-access'

// ── Prepare (turn start) ──

export interface MemoryPrepareOptions {
  /** Disabled for team turns (many turns per epoch would flood History). Default: true. */
  preInsertHistory?: boolean
  /**
   * Rendered tag for the execution opening the entry, stamped on the heading so
   * a later reader can tell whose entry it is. Omitted leaves the entry
   * unattributed rather than attributing it to the wrong execution.
   */
  byLabel?: string
}

export interface PreparedMemory {
  snapshot: MemorySnapshot
  runTimestamp: string
}

export async function prepareMemoryForTurn(
  scope: MemoryCallerScope,
  opts: MemoryPrepareOptions = {}
): Promise<PreparedMemory> {
  const layout = resolveMemoryLayout(scope, 'app')
  const runTimestamp = formatTimestamp(new Date())

  // Insert first, then snapshot. The agent is told the system already opened a
  // heading for this turn and to edit its summary into it; a snapshot taken
  // beforehand is stale by exactly that line, leaving it looking for a heading
  // the message it was given does not contain.
  if (opts.preInsertHistory !== false) {
    await insertHistoryHeading(layout.file, runTimestamp, opts.byLabel)
  } else if (await ensureMemoryFile(layout, 'digital-human')) {
    console.log(`[Runtime][${scope.appId}] Memory created: ${layout.file}`)
  }

  const snapshot = await buildMemorySnapshot(layout)
  console.log(`[Runtime][${scope.appId}] Memory loaded: ${formatMemoryUsage(snapshot)}`)

  return { snapshot, runTimestamp }
}

/** What a digital human's memory instructions are shaped by. */
export function memoryPromptOptions(appId: string, spec: AppSpec): MemoryPromptOptions {
  return { tracks: memoryTracksFromSpec(spec), inTeam: belongsToAnyTeam(appId) }
}

/** Unknown (store not ready, read failed) counts as in a team: the guidance is the safe side. */
function belongsToAnyTeam(appId: string): boolean {
  const store = getTeamStore()
  if (!store) return true
  try {
    return store.listMembersByAppId(appId).length > 0
  } catch (err) {
    console.warn(`[Runtime][${appId}] Team membership unknown, keeping team guidance:`, (err as Error).message)
    return true
  }
}

/** `memory_schema` as items for the memory instructions; undefined when absent. */
export function memoryTracksFromSpec(spec: AppSpec): MemoryTrackedItem[] | undefined {
  if (spec.type !== 'automation' || !spec.memory_schema) return undefined
  const items = Object.entries(spec.memory_schema).map(([name, field]) => ({
    name,
    type: field.type,
    description: field.description,
  }))
  return items.length > 0 ? items : undefined
}

// ── Settings ──

/** This digital human's memory settings, defaults filled in. */
export function appMemorySettings(app: { userOverrides?: { memory?: MemorySettings } }): ResolvedMemorySettings {
  return resolveMemorySettings(app.userOverrides?.memory)
}

// ── Space memory topics ──

/**
 * The space's topics, offered read-only in the opening snapshot when allowed,
 * guests included. Later turns retrieve current content with native file tools.
 */
export async function loadSpaceTopicsForTurn(
  scope: MemoryCallerScope,
  opts: { enabledForApp: boolean }
): Promise<TopicsTree | null> {
  if (!opts.enabledForApp) return null
  if (!isSpaceMemoryEnabled(scope.spaceId)) return null
  try {
    const tree = await scanTopics(resolveMemoryLayout(scope, 'space').topicsDir)
    return tree.topicCount > 0 ? tree : null
  } catch (err) {
    console.error(`[Runtime][${scope.appId}] Space memory topics unavailable, continuing without it:`, err)
    return null
  }
}

/**
 * What this digital human's file tools may touch: its own memory, under that
 * memory's lock — unless its memory is turned off; its space's memory, never —
 * reading it is allowed, writing is not, whether or not it was offered.
 */
export function appMemoryGuard(
  scope: MemoryCallerScope,
  label: string,
  settings: ResolvedMemorySettings
): MemoryWriteGuardConfig {
  const own = resolveMemoryLayout(scope, 'app')
  const space = resolveMemoryLayout(scope, 'space')
  return settings.enabled
    ? { writable: [own], readOnly: [space], label }
    : { writable: [], readOnly: [own, space], label }
}

/**
 * The file boundary of a restricted turn of this digital human (see
 * turn-file-access). Memory is its content only — memory.md and topics, never
 * run records, archives or snapshots — and the space's topics only when the
 * owner offered them and the space has memory on.
 */
export function appTurnFileAccess(
  scope: MemoryCallerScope,
  opts: { memoryActive: boolean; spaceMemoryOffered: boolean; workDir: string; attachedFiles: string[] }
): TurnFileAccess {
  const own = resolveMemoryLayout(scope, 'app')
  const space = resolveMemoryLayout(scope, 'space')
  const systemPaths = (layout: MemoryLayout) => [
    layout.runDir, layout.archiveDir, layout.snapshotsDir, layout.consolidationDir, layout.stateFile,
  ]
  return {
    cwd: opts.workDir,
    memoryWritable: opts.memoryActive ? memoryContentPaths(own) : [],
    memoryReadable: opts.memoryActive && opts.spaceMemoryOffered ? [space.topicsDir] : [],
    attachedFiles: opts.attachedFiles,
    workspaceRoots: [opts.workDir],
    closed: [...new Set([join(opts.workDir, '.halo'), join(scope.spacePath, '.halo')])],
    // Where images for a text-only model are persisted (services/agent image-attachments).
    hookGuarded: [...new Set([join(opts.workDir, '.halo', 'attachments'), join(scope.spacePath, '.halo', 'attachments')])],
    memorySystemPaths: [...systemPaths(own), ...systemPaths(space)],
  }
}

// ── Consolidation ──

export interface AppConsolidationInputs {
  appName: string
  settings: ResolvedMemorySettings
  resolveCredentials: () => Promise<ResolvedSdkCredentials>
  /** Whether another execution of this digital human is running */
  isBusy: () => boolean
}

export function appConsolidationRequest(
  scope: MemoryCallerScope,
  inputs: AppConsolidationInputs,
  tag: string
): ConsolidationRequest {
  return {
    layout: resolveMemoryLayout(scope, 'app'),
    ownerKind: 'digital-human',
    ownerName: inputs.appName,
    spaceId: scope.spaceId,
    settings: inputs.settings,
    resolveCredentials: inputs.resolveCredentials,
    isBusy: inputs.isBusy,
    tag,
  }
}

/** Detached; see services/memory-consolidation. Nothing when memory is off. */
export function requestAppMemoryConsolidation(
  scope: MemoryCallerScope,
  inputs: AppConsolidationInputs,
  tag: string
): void {
  if (!inputs.settings.enabled) return
  try {
    requestConsolidation(appConsolidationRequest(scope, inputs, tag))
  } catch (err) {
    console.error(`[Runtime][${tag}] Memory consolidation request failed:`, err)
  }
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

export interface MemoryFinalizeOptions {
  saveSessionSummary?: boolean
  consolidate?: boolean
}

/** Best-effort: failures are logged, never re-thrown. Nothing when memory is off. */
export async function finalizeMemoryAfterTurn(
  memory: MemoryService,
  scope: MemoryCallerScope,
  ctx: MemoryFinalizeContext,
  consolidation: AppConsolidationInputs,
  opts: MemoryFinalizeOptions = {}
): Promise<void> {
  if (!consolidation.settings.enabled) return
  if (opts.saveSessionSummary !== false) {
    await saveRunSessionSummary(memory, scope, ctx)
  }
  if (opts.consolidate !== false) {
    requestAppMemoryConsolidation(scope, consolidation, ctx.runTag)
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
