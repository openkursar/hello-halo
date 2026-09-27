/**
 * addSdkHooks: every concern that watches tool calls shares the one `hooks`
 * option. A caller adding its own hooks must never drop what an earlier concern
 * installed — the delegation audit once replaced the memory write guard.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

import { addSdkHooks } from '../../../../src/main/services/agent/sdk-config'
import { createMemoryWriteHooks } from '../../../../src/main/platform/memory/guard'
import { resolveMemoryLayout } from '../../../../src/main/platform/memory/paths'
import { createDelegationAuditHooks } from '../../../../src/main/apps/runtime/delegation-gate'

describe('addSdkHooks', () => {
  it('keeps the memory guard when the delegation audit is added after it', () => {
    const layout = resolveMemoryLayout({ type: 'app', spaceId: 's', spacePath: '/sp', appId: 'dh' }, 'app')
    const guard = createMemoryWriteHooks({ writable: [layout], label: 't' })
    const options: Record<string, any> = {}

    addSdkHooks(options, guard)
    addSdkHooks(options, createDelegationAuditHooks('conv-1'))

    expect(options.hooks.PreToolUse).toEqual(guard.PreToolUse)
    expect(options.hooks.PostToolUse).toHaveLength(guard.PostToolUse.length + 1)
    expect(options.hooks.PostToolUse.slice(0, guard.PostToolUse.length)).toEqual(guard.PostToolUse)
    expect(options.hooks.PostToolUseFailure).toEqual(guard.PostToolUseFailure)
  })

  it('creates the option when there is none', () => {
    const options: Record<string, any> = {}
    addSdkHooks(options, { PreToolUse: [{ matcher: 'Read', hooks: [] }] })
    expect(options.hooks.PreToolUse).toHaveLength(1)
  })
})
