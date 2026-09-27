/**
 * platform/memory -- Write Guard
 *
 * The agent edits memory with its own file tools, which never pass through this
 * module. This guard is how they are held to the same rules anyway: engine
 * hooks that run around every file-writing tool call.
 *
 * - A write to a memory this session may write takes that memory's lock before
 *   the tool runs and gives it back after, so it can never interleave with the
 *   system's own read-modify-writes (History headings, a consolidation's swap)
 *   or another session's edit. A writer that cannot get the lock in time is
 *   refused with a reason, not left waiting.
 * - A write into a system-managed folder (archives, run records, snapshots, a
 *   consolidation's working copy) is refused.
 * - A write to a memory this session may only read is refused.
 *
 * Staleness — editing on top of content someone else has since changed — is not
 * handled here: the engine's Edit/Write already refuse a file modified since the
 * agent last read it, and the lock makes that check race-free.
 *
 * The hooks are plain callbacks shaped for the Claude-protocol engines; the
 * caller decides whether the active engine runs them.
 */

import { acquireMemoryLock } from './file-ops'
import { canonicalPath, isPathWithin, resolveToolPath } from '../../foundation/path-containment'
import type { MemoryLayout } from './paths'

export interface MemoryWriteGuardConfig {
  /** Memories this session writes; each write takes that memory's lock */
  writable: MemoryLayout[]
  /** Memories this session may read and never write */
  readOnly?: MemoryLayout[]
  /** Who the session is, for logs */
  label: string
}

/** How long a write waits for a busy memory before it is refused. */
const LOCK_WAIT_MS = 30_000
/** A held lock is given back on its own after this, should no release arrive. */
const LOCK_LEASE_MS = 15_000

const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

type HookInput = {
  hook_event_name: string
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  agent_id?: string
}

type HookOutput = Record<string, unknown>

type HookCallback = (
  input: HookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookOutput>

export type HookMatchers = Record<string, Array<{ matcher?: string; hooks: HookCallback[]; timeout?: number }>>

function targetPath(input: HookInput): string | null {
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
  const raw = toolInput.file_path ?? toolInput.notebook_path
  if (typeof raw !== 'string' || raw.length === 0) return null
  return resolveToolPath(raw, input.cwd ?? process.cwd())
}

function owns(layout: MemoryLayout, target: string): boolean {
  return canonicalPath(target) === canonicalPath(layout.file) || isPathWithin(target, layout.dataDir)
}

function systemManaged(layout: MemoryLayout, target: string): boolean {
  return canonicalPath(target) === canonicalPath(layout.stateFile) ||
    [layout.snapshotsDir, layout.consolidationDir, layout.archiveDir, layout.runDir]
      .some(dir => isPathWithin(target, dir))
}

/**
 * What of a memory is its content, as opposed to the system's records about it
 * (run records, archives, snapshots, state): memory.md and the topics. The
 * reach of anyone given access to a memory rather than to its owner's files.
 */
export function memoryContentPaths(layout: MemoryLayout): string[] {
  return [layout.file, layout.topicsDir]
}

function deny(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

/**
 * Build the hook set for one session.
 *
 * One matcher entry per tool: the Claude engine reads a matcher as a regex, the
 * Halo engine only as an exact name or a `prefix*`, so a `A|B` alternation
 * would silently match nothing there.
 *
 * @returns An object for the engine's `hooks` option
 */
export function createMemoryWriteHooks(config: MemoryWriteGuardConfig): HookMatchers {
  const held = new Map<string, () => void>()
  // A call refused after this guard ran (by a later hook or the permission
  // gate) never reaches a post-tool hook, so its lock would wait out the lease.
  // File-writing tools run one at a time per agent, so the next write from the
  // same agent proves the previous one is over.
  const lastByAgent = new Map<string, string>()

  const releaseFor = (toolUseId: string | undefined): void => {
    if (!toolUseId) return
    const release = held.get(toolUseId)
    if (release) {
      held.delete(toolUseId)
      release()
    }
  }

  const pre: HookCallback = async (input, toolUseId, { signal }) => {
    const target = targetPath(input)
    if (!target) return {}

    for (const layout of config.readOnly ?? []) {
      if (owns(layout, target)) {
        console.log(`[Memory][Guard][${config.label}] Refused write to read-only memory: ${target}`)
        return deny(
          'This memory is read-only for you. Record what you learned in your own memory instead.'
        )
      }
    }

    const layout = config.writable.find(l => owns(l, target))
    if (!layout) return {}

    if (systemManaged(layout, target)) {
      console.log(`[Memory][Guard][${config.label}] Refused write to system-managed memory path: ${target}`)
      return deny(
        'This folder is maintained by the system (archives, run records, snapshots). ' +
        'Write to memory.md or memory/topics/ instead.'
      )
    }

    const id = toolUseId ?? input.tool_use_id
    const agent = input.agent_id ?? 'main'
    const previous = lastByAgent.get(agent)
    if (previous && previous !== id) releaseFor(previous)

    const release = await acquireMemoryLock(layout.file, { timeoutMs: LOCK_WAIT_MS, leaseMs: LOCK_LEASE_MS })
    if (!release) {
      console.warn(`[Memory][Guard][${config.label}] Memory busy for ${LOCK_WAIT_MS}ms, refused write: ${target}`)
      return deny('Memory is busy (another writer is updating it). Read the file again, then retry the edit.')
    }
    if (signal.aborted || !id) {
      release()
      return {}
    }
    held.set(id, release)
    lastByAgent.set(agent, id)
    return {}
  }

  const post: HookCallback = async (input, toolUseId) => {
    releaseFor(toolUseId ?? input.tool_use_id)
    return {}
  }

  // Seconds; above the lock wait so the engine never abandons a waiting hook.
  const timeout = Math.ceil(LOCK_WAIT_MS / 1000) + 15
  const each = (hook: HookCallback, withTimeout = false) =>
    WRITE_TOOLS.map(matcher => ({ matcher, hooks: [hook], ...(withTimeout ? { timeout } : {}) }))
  return {
    PreToolUse: each(pre, true),
    PostToolUse: each(post),
    PostToolUseFailure: each(post),
    PermissionDenied: each(post),
  }
}
