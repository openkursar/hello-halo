/**
 * platform/memory write guard: the agent's file tools are held to memory
 * boundaries and take the same lock as the system's own writers.
 */

import { describe, it, expect } from 'vitest'
import { createMemoryWriteHooks } from '../../../../src/main/platform/memory/guard'
import { resolveMemoryLayout } from '../../../../src/main/platform/memory/paths'
import { acquireMemoryLock } from '../../../../src/main/platform/memory/file-ops'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'

// The Halo engine's own hook matching, from its build output. That output is
// not committed, so these cases are skipped where the SDK has not been built.
const HALO_HOOKS_PATH = '../../../../src/sdk/halo-sdk/dist/core/hooks.js'
const haloHooks: typeof import('../../../../src/sdk/halo-sdk/dist/core/hooks.js') | null =
  existsSync(fileURLToPath(new URL(HALO_HOOKS_PATH, import.meta.url))) ? await import(HALO_HOOKS_PATH) : null

const appLayout = resolveMemoryLayout({ type: 'app', spaceId: 's', spacePath: '/sp', appId: 'dh' }, 'app')
const spaceLayout = resolveMemoryLayout({ type: 'user', spaceId: 's', spacePath: '/sp' }, 'space')

const signal = new AbortController().signal
type Hook = (input: Record<string, unknown>, id: string | undefined, o: { signal: AbortSignal }) => Promise<Record<string, unknown>>

function hooks() {
  const set = createMemoryWriteHooks({ writable: [appLayout], readOnly: [spaceLayout], label: 't' })
  return {
    pre: set.PreToolUse[0].hooks[0] as unknown as Hook,
    post: set.PostToolUse[0].hooks[0] as unknown as Hook,
  }
}

function writeTo(file: string, id = 'tu-1') {
  return [{ hook_event_name: 'PreToolUse', cwd: '/', tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: id }, id, { signal }] as const
}

function denied(out: Record<string, unknown>): boolean {
  return (out.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'deny'
}

describe('memory write guard', () => {
  it.skipIf(!haloHooks)('reaches every file-writing tool through the Halo engine\'s own matching', async () => {
    const { runPreToolUseHooks } = haloHooks!
    // Exact names or `prefix*` only there — an `A|B` matcher silently matched nothing.
    const set = createMemoryWriteHooks({ writable: [appLayout], readOnly: [spaceLayout], label: 't' })
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const result = await runPreToolUseHooks(
        set as never, tool, { file_path: spaceLayout.file, notebook_path: spaceLayout.file },
        `tu-${tool}`, 'session', '/', signal
      )
      expect(result.decision).toBe('deny')
    }
    const other = await runPreToolUseHooks(set as never, 'Read', { file_path: spaceLayout.file }, 'tu-read', 'session', '/', signal)
    expect(other.decision).toBeUndefined()
  })

  it('releases a lock left by a call refused after the guard ran, at the next write', async () => {
    const { pre, post } = hooks()
    expect(await pre(...writeTo(`${appLayout.topicsDir}/a.md`, 'tu-refused'))).toEqual({})
    // No post-tool hook arrives for tu-refused (a later layer refused it); the
    // next write from the same agent must not wait out its lease.
    const started = Date.now()
    expect(await pre(...writeTo(`${appLayout.topicsDir}/b.md`, 'tu-next'))).toEqual({})
    expect(Date.now() - started).toBeLessThan(1000)
    await post({ hook_event_name: 'PostToolUse', tool_use_id: 'tu-next' }, 'tu-next', { signal })
  })

  it('lets writes outside any memory through untouched', async () => {
    const { pre } = hooks()
    expect(await pre(...writeTo('/sp/src/index.ts'))).toEqual({})
  })

  it('refuses writes to a memory the session may only read', async () => {
    const { pre } = hooks()
    expect(denied(await pre(...writeTo(spaceLayout.file)))).toBe(true)
    expect(denied(await pre(...writeTo(`${spaceLayout.topicsDir}/a.md`)))).toBe(true)
  })

  it('refuses writes into system-managed folders of its own memory', async () => {
    const { pre } = hooks()
    for (const dir of [appLayout.snapshotsDir, appLayout.archiveDir, appLayout.runDir, appLayout.consolidationDir]) {
      expect(denied(await pre(...writeTo(`${dir}/x.md`)))).toBe(true)
    }
  })

  it('holds the memory lock from before the write until after it', async () => {
    const { pre, post } = hooks()
    expect(await pre(...writeTo(`${appLayout.topicsDir}/faq.md`, 'tu-lock'))).toEqual({})

    // The system's own writer must wait while the tool runs.
    expect(await acquireMemoryLock(appLayout.file, { timeoutMs: 20 })).toBeNull()

    await post({ hook_event_name: 'PostToolUse', tool_use_id: 'tu-lock' }, 'tu-lock', { signal })
    const release = await acquireMemoryLock(appLayout.file, { timeoutMs: 100 })
    expect(release).toBeTypeOf('function')
    release!()
  })

  it('resolves a relative path against the tool call cwd', async () => {
    const { pre } = hooks()
    const out = await pre({ hook_event_name: 'PreToolUse', cwd: '/sp/.halo', tool_name: 'Write', tool_input: { file_path: 'memory.md' } }, 'tu-2', { signal })
    expect(denied(out)).toBe(true)
  })
})
