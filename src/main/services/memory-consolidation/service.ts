/**
 * Consolidation scheduling and the harness around the agent: one at a time per
 * memory, when due by the owner's cadence, with the agent kept at it until its
 * result is accepted. See index.ts for the module contract.
 */

import { existsSync } from 'fs'
import {
  isConsolidationDue,
  isArchiveDue,
  assessConsolidation,
  prepareConsolidation,
  validateConsolidation,
  commitConsolidation,
  rebaseWorkspace,
  mergeTargets,
  fingerprintMergeTargets,
  discardConsolidation,
  trimHistoryFallback,
  recordCommit,
  recordFailedAttempt,
  recordArchive,
  readMemoryStatus,
  historyKeepFor,
  MEMORY_SECTION_LIMITS,
  buildMemorySnapshot,
  type ConsolidationWorkspace,
  type MemoryLayout,
  type MemoryOwnerKind,
} from '../../platform/memory'
import type { MemoryStatus, ResolvedMemorySettings } from '../../../shared/types/memory'
import type { ResolvedSdkCredentials } from '../agent/sdk-config'
import { createConsolidationAgent } from './runner'
import { buildConflictFeedback, buildUnmergedFeedback, buildValidationFeedback, UNFINISHED_FEEDBACK } from './prompt'

export interface ConsolidationRequest {
  layout: MemoryLayout
  ownerKind: MemoryOwnerKind
  /** Shown to the consolidating agent: whose memory this is */
  ownerName: string
  spaceId: string
  settings: Pick<ResolvedMemorySettings, 'autoConsolidate' | 'cadence'>
  /** Resolved only when a consolidation actually starts */
  resolveCredentials: () => Promise<ResolvedSdkCredentials>
  /** Whether another execution is working on this memory right now */
  isBusy?: () => boolean
  tag: string
}

/** Rounds after the first in which the agent is told what to fix. */
const MAX_FEEDBACK_ROUNDS = 3
/**
 * Triggers skipped because the memory was busy before starting anyway. A
 * digital human with a long-lived chat open is "busy" indefinitely; its memory
 * must still get consolidated, and the commit handles changes made meanwhile.
 */
const BUSY_SKIPS_BEFORE_FORCE = 5

/** Memories whose consolidation (or History trim) is running */
const running = new Set<string>()
/** Memories an automatic trigger is checking — not yet running anything */
const checking = new Set<string>()
const busySkips = new Map<string, number>()

/**
 * After a turn: consolidate if due. Returns at once; the work runs detached and
 * never throws to the caller.
 */
export function requestConsolidation(req: ConsolidationRequest): void {
  const key = req.layout.file
  // Claimed before the first await, so two turns ending together cannot both
  // start — the second would delete the first one's working folder.
  if (running.has(key) || checking.has(key)) return
  checking.add(key)
  void consolidateIfDue(req)
    .catch(err => console.error(`[MemoryConsolidation][${req.tag}] Unexpected failure:`, err))
    .finally(() => checking.delete(key))
}

/**
 * The owner asked for it: consolidate now, whatever the thresholds, cooldown,
 * interval or other executions. Returns once started. An automatic trigger
 * that is only checking does not block it — it yields once it sees this run.
 */
export function consolidateNow(req: ConsolidationRequest): { started: boolean; reason?: 'already-running' | 'empty' } {
  const key = req.layout.file
  if (running.has(key)) return { started: false, reason: 'already-running' }
  if (!existsSync(req.layout.file)) return { started: false, reason: 'empty' }
  running.add(key)
  console.log(`[MemoryConsolidation][${req.tag}] Requested by the owner`)
  void runHarness(req)
    .catch(err => console.error(`[MemoryConsolidation][${req.tag}] Unexpected failure:`, err))
    .finally(() => running.delete(key))
  return { started: true }
}

export function isConsolidating(layout: MemoryLayout): boolean {
  return running.has(layout.file)
}

/**
 * Move from checking to running; false when the owner's run got there first.
 * Whoever claims releases `running` when done.
 */
function claimRun(key: string): boolean {
  checking.delete(key)
  if (running.has(key)) return false
  running.add(key)
  return true
}

function nowCapFor(req: ConsolidationRequest): number {
  return MEMORY_SECTION_LIMITS[req.ownerKind].nowLimitBytes
}

export async function getMemoryStatus(layout: MemoryLayout): Promise<MemoryStatus> {
  return { ...(await readMemoryStatus(layout)), consolidating: isConsolidating(layout) }
}

async function consolidateIfDue(req: ConsolidationRequest): Promise<void> {
  const { layout, settings, tag } = req
  const key = layout.file
  const opts = { nowCapBytes: nowCapFor(req) }

  if (!settings.autoConsolidate) {
    // Automatic consolidation is off: memory is not reorganised, only History
    // kept from growing without bound (see isArchiveDue).
    const due = await isArchiveDue(layout, settings.cadence)
    if (!due.archiveDue) return
    if (!claimRun(key)) return
    try {
      const trimmed = await trimHistoryFallback(layout, historyKeepFor(settings.cadence))
      if (trimmed) {
        console.log(`[MemoryConsolidation][${tag}] Auto-consolidation off; ${due.reasons.join(', ')} → archived old History`)
        await recordArchive(layout, settings.cadence)
      }
    } finally {
      running.delete(key)
    }
    return
  }

  const due = await isConsolidationDue(layout, settings.cadence, opts)
  if (!due.due) return

  if (req.isBusy?.()) {
    const skipped = (busySkips.get(key) ?? 0) + 1
    if (skipped < BUSY_SKIPS_BEFORE_FORCE) {
      busySkips.set(key, skipped)
      console.log(`[MemoryConsolidation][${tag}] Due (${due.reasons.join(', ')}) but memory is in use; deferred (${skipped}/${BUSY_SKIPS_BEFORE_FORCE})`)
      return
    }
  }
  busySkips.delete(key)
  if (!claimRun(key)) return
  console.log(`[MemoryConsolidation][${tag}] Due: ${due.reasons.join(', ')}`)
  try {
    await runHarness(req)
  } finally {
    running.delete(key)
  }
}

/**
 * Run the agent until its result is accepted, or until it has had its rounds.
 * A result that fails validation, or meets changes made meanwhile, goes back to
 * the same agent with what to fix. Only when that is exhausted is History
 * trimmed without it, and the memory cools down until it grows.
 *
 * @returns Whether a consolidation was committed
 */
async function runHarness(req: ConsolidationRequest): Promise<boolean> {
  const { layout, settings, tag } = req
  const started = Date.now()
  const before = await buildMemorySnapshot(layout)
  console.log(
    `[MemoryConsolidation][${tag}] Starting: memory=${before.sizeBytes}B now=${before.nowBytes}B ` +
    `topics=${before.topics.topicCount} cadence=${settings.cadence}`
  )

  let credentials: ResolvedSdkCredentials
  try {
    credentials = await req.resolveCredentials()
  } catch (err) {
    console.error(`[MemoryConsolidation][${tag}] No model available:`, err)
    await giveUp(req, `no model available: ${(err as Error).message}`)
    return false
  }

  let ws: ConsolidationWorkspace | null = null
  try {
    ws = await prepareConsolidation(layout)
    const agent = createConsolidationAgent({
      ws,
      credentials,
      spaceId: req.spaceId,
      ownerName: req.ownerName,
      ownerKind: req.ownerKind,
      memoryBytes: before.sizeBytes,
      nowBytes: before.nowBytes,
      topicCount: before.topics.topicCount,
      tag,
    })

    let outcome = await agent.start()
    let lastReason = ''
    // Once the workspace is rebased onto the live memory, a commit would take
    // the agent's copy as the merge of what the live one gained meanwhile; so
    // the merge instructions travel with every round until a result is
    // accepted, and a file the agent was asked to merge into but left exactly
    // as it was blocks the commit. A newer conflict is only met by a commit, so
    // every earlier target has been worked on by the time it replaces them.
    let pendingConflict: string | null = null
    let handedOver = new Map<string, string>()
    for (let round = 0; ; round++) {
      if (!outcome.ok) {
        lastReason = outcome.reason
        break
      }
      if (outcome.summary) console.log(`[MemoryConsolidation][${tag}] Agent: ${outcome.summary.slice(0, 1000)}`)

      if (pendingConflict && outcome.exhausted) {
        lastReason = 'ran out of turns while merging changes made meanwhile'
        console.warn(`[MemoryConsolidation][${tag}] Round ${round + 1} ${lastReason}`)
        if (round >= MAX_FEEDBACK_ROUNDS) break
        outcome = await agent.followUp([UNFINISHED_FEEDBACK, pendingConflict])
        continue
      }

      const validation = await validateConsolidation(ws, settings.cadence)
      if (!validation.ok) {
        lastReason = `rejected: ${validation.reason}`
        console.warn(`[MemoryConsolidation][${tag}] Round ${round + 1} ${lastReason}`)
        if (round >= MAX_FEEDBACK_ROUNDS) break
        const feedback = buildValidationFeedback(validation.reason)
        outcome = await agent.followUp(pendingConflict ? [pendingConflict, feedback] : [feedback])
        continue
      }

      const unmerged = await untouchedTargets(ws, handedOver)
      if (unmerged.length > 0 && pendingConflict) {
        lastReason = `changes made meanwhile not merged into ${unmerged.join(', ')}`
        console.warn(`[MemoryConsolidation][${tag}] Round ${round + 1} ${lastReason}`)
        if (round >= MAX_FEEDBACK_ROUNDS) break
        outcome = await agent.followUp([buildUnmergedFeedback(unmerged), pendingConflict])
        continue
      }

      const result = await commitConsolidation(ws)
      if (result.status === 'committed') {
        await recordCommit(layout)
        const after = await buildMemorySnapshot(layout)
        console.log(
          `[MemoryConsolidation][${tag}] Committed in ${Math.round((Date.now() - started) / 1000)}s ` +
          `after ${round + 1} round(s): memory ${before.sizeBytes}B→${after.sizeBytes}B, ` +
          `now ${before.nowBytes}B→${after.nowBytes}B, topics ${before.topics.topicCount}→${after.topics.topicCount}; ` +
          `snapshot=${result.snapshotDir}` +
          (result.carriedHistory ? `; carried over ${result.carriedHistory} History entries written meanwhile` : '') +
          (result.mergedTopics ? `; merged ${result.mergedTopics} topic changes made meanwhile` : '') +
          (validation.notes.length ? `; ${validation.notes.join('; ')}` : '')
        )
        return true
      }

      lastReason = `conflict: ${result.reason}`
      console.warn(
        `[MemoryConsolidation][${tag}] Round ${round + 1} ${lastReason}; carried ${result.changes.carriedHistory} History ` +
        `entries and ${result.changes.mergedTopics} topic changes by itself, handing the rest to the agent`
      )
      if (round >= MAX_FEEDBACK_ROUNDS) break
      rebaseWorkspace(ws, result.liveBaseline)
      pendingConflict = buildConflictFeedback(result.changes)
      handedOver = await fingerprintMergeTargets(ws, mergeTargets(result.changes))
      outcome = await agent.followUp([pendingConflict])
    }

    await giveUp(req, lastReason)
    return false
  } catch (err) {
    console.error(`[MemoryConsolidation][${tag}] Consolidation threw, memory unchanged:`, err)
    await giveUp(req, `error: ${(err as Error).message}`)
    return false
  } finally {
    if (ws) {
      const dir = ws.dir
      await discardConsolidation(ws).catch(err => {
        console.error(`[MemoryConsolidation][${tag}] Failed to remove workspace ${dir}:`, err)
      })
    }
  }
}

/** Merge targets whose workspace content is still what it was when handed over. */
async function untouchedTargets(ws: ConsolidationWorkspace, handedOver: Map<string, string>): Promise<string[]> {
  if (handedOver.size === 0) return []
  const now = await fingerprintMergeTargets(ws, [...handedOver.keys()])
  return [...handedOver].filter(([target, before]) => now.get(target) === before).map(([target]) => target)
}

/**
 * The agent could not produce an accepted result. History is trimmed only if it
 * is actually over its limit — a failed "consolidate now" on a small memory
 * leaves it as it was — and the memory cools down until it grows.
 */
async function giveUp(req: ConsolidationRequest, reason: string): Promise<void> {
  const { layout, settings, tag } = req
  const opts = { nowCapBytes: nowCapFor(req) }
  try {
    const assessment = await assessConsolidation(layout, settings.cadence, opts)
    const trimmed = assessment.overHistory || assessment.overTotal
      ? await trimHistoryFallback(layout, historyKeepFor(settings.cadence))
      : false
    const { cooldownUntilBytes } = await recordFailedAttempt(
      layout, settings.cadence, trimmed ? 'trimmed' : 'failed', reason, opts
    )
    console.warn(
      `[MemoryConsolidation][${tag}] Gave up (${reason}) — ` +
      (trimmed ? 'trimmed # History to its newest entries (archived first)' : 'memory left as it was') +
      (cooldownUntilBytes ? `; next automatic attempt once memory.md reaches ${cooldownUntilBytes}B` : '')
    )
  } catch (err) {
    console.error(`[MemoryConsolidation][${tag}] Fallback failed:`, err)
  }
}
