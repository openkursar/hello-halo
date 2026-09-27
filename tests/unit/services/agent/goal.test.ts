/**
 * Conversation goal routing (services/agent/goal).
 *
 * The engine owns the goal; the host routes a read or a set to the
 * conversation's live session, starting it the way a conversation switch does,
 * and keeps a draft for a conversation whose engine session has no recorded id
 * yet — seeded into each fresh session so the goal survives a session that was
 * never created or one rebuilt before the first turn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { emitAgentEvent, getEngineCapabilities, ensureSessionWarm, v2Sessions, getConversation } = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  getEngineCapabilities: vi.fn(),
  ensureSessionWarm: vi.fn(async () => {}),
  v2Sessions: new Map<string, { session: Record<string, unknown> }>(),
  getConversation: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({ getEngineCapabilities }))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({ ensureSessionWarm, v2Sessions }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ getConversation }))

import {
  getConversationGoal,
  setConversationGoal,
  prepareGoalInput,
  setGoalForTurn,
} from '../../../../src/main/services/agent/goal'
import { applyGoalDraft, setGoalDraft } from '../../../../src/main/services/agent/goal/draft'
import { ANTHROPIC_CAPABILITIES, HALO_CAPABILITIES, CODEX_CAPABILITIES } from '../../../../src/main/services/agent/capabilities'
import type { Goal, GoalInput } from '../../../../src/shared/types/goal'

const SPACE = 'space-1'
const CONV = 'conv-1'

/** A live halo-style session whose goal behaves like the engine's store. */
function goalSession(initial: Goal | null = null) {
  let current = initial
  return {
    getGoal: vi.fn(() => current),
    setGoal: vi.fn((input: GoalInput | null) => {
      current = input
        ? { objective: input.objective, doneWhen: input.doneWhen ?? [], status: 'active', updatedBy: 'user', updatedAt: 'now' }
        : null
      return current
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  v2Sessions.clear()
  setGoalDraft(CONV, null)
  getEngineCapabilities.mockReturnValue(HALO_CAPABILITIES)
  getConversation.mockReturnValue({ id: CONV })
})

describe('capability flag', () => {
  it('is on only for the halo engine', () => {
    expect(HALO_CAPABILITIES.features.goal).toBe(true)
    expect(ANTHROPIC_CAPABILITIES.features.goal).toBe(false)
    expect(CODEX_CAPABILITIES.features.goal).toBe(false)
  })
})

describe('engine without goals', () => {
  beforeEach(() => getEngineCapabilities.mockReturnValue(ANTHROPIC_CAPABILITIES))

  it('reads as no goal without touching a session', async () => {
    expect(await getConversationGoal(SPACE, CONV)).toBeNull()
    expect(ensureSessionWarm).not.toHaveBeenCalled()
  })

  it('refuses a set', async () => {
    await expect(setConversationGoal(SPACE, CONV, { objective: 'x' })).rejects.toThrow(/does not support goals/)
    expect(emitAgentEvent).not.toHaveBeenCalled()
  })
})

describe('live session', () => {
  it('sets through the session, keeps a draft until the session id is recorded, and announces the change', async () => {
    const session = goalSession()
    v2Sessions.set(CONV, { session })

    const goal = await setConversationGoal(SPACE, CONV, { objective: '  Ship it  ', doneWhen: [' tests pass ', ''] })

    expect(session.setGoal).toHaveBeenCalledWith({ objective: 'Ship it', doneWhen: ['tests pass'] })
    expect(goal?.objective).toBe('Ship it')
    expect(emitAgentEvent).toHaveBeenCalledWith('agent:goal-updated', SPACE, CONV, { goal, source: 'user', seenByModel: false })

    const options: Record<string, unknown> = {}
    applyGoalDraft(options, CONV)
    expect(options.goal).toEqual({ objective: 'Ship it', doneWhen: ['tests pass'] })
  })

  it('reads the session goal', async () => {
    const existing: Goal = { objective: 'o', doneWhen: [], status: 'complete', updatedBy: 'agent', updatedAt: 't' }
    v2Sessions.set(CONV, { session: goalSession(existing) })
    expect(await getConversationGoal(SPACE, CONV)).toBe(existing)
  })

  it('drops the draft once the conversation has an engine session id', async () => {
    setGoalDraft(CONV, { objective: 'old', doneWhen: [], status: 'active', updatedBy: 'user', updatedAt: 't' })
    getConversation.mockReturnValue({ id: CONV, sessionId: 'sess-1' })
    v2Sessions.set(CONV, { session: goalSession() })

    await setConversationGoal(SPACE, CONV, { objective: 'new' })

    const options: Record<string, unknown> = {}
    applyGoalDraft(options, CONV)
    expect(options.goal).toBeUndefined()
  })
})

describe('no live session', () => {
  it('starts the session through warm-up and uses it', async () => {
    const session = goalSession()
    ensureSessionWarm.mockImplementationOnce(async () => { v2Sessions.set(CONV, { session }) })

    await setConversationGoal(SPACE, CONV, { objective: 'o' })

    expect(ensureSessionWarm).toHaveBeenCalledWith(SPACE, CONV)
    expect(session.setGoal).toHaveBeenCalled()
  })

  it('holds a new conversation goal as a draft when no session can start', async () => {
    const goal = await setConversationGoal(SPACE, CONV, { objective: 'o', doneWhen: ['c'] })

    expect(goal).toMatchObject({ objective: 'o', doneWhen: ['c'], status: 'active', updatedBy: 'user' })
    expect(await getConversationGoal(SPACE, CONV)).toEqual(goal)

    await setConversationGoal(SPACE, CONV, null)
    expect(await getConversationGoal(SPACE, CONV)).toBeNull()
    expect(emitAgentEvent).toHaveBeenLastCalledWith('agent:goal-updated', SPACE, CONV, { goal: null, source: 'user', seenByModel: false })
  })

  it('refuses when a resumable conversation cannot start its session', async () => {
    getConversation.mockReturnValue({ id: CONV, sessionId: 'sess-1' })
    await expect(setConversationGoal(SPACE, CONV, { objective: 'o' })).rejects.toThrow(/not available/)
    expect(emitAgentEvent).not.toHaveBeenCalled()
  })

  it('reads a resumable conversation as no goal when its session cannot start', async () => {
    getConversation.mockReturnValue({ id: CONV, sessionId: 'sess-1' })
    expect(await getConversationGoal(SPACE, CONV)).toBeNull()
  })
})

it('rejects a blank objective before reaching the engine', async () => {
  const session = goalSession()
  v2Sessions.set(CONV, { session })
  await expect(setConversationGoal(SPACE, CONV, { objective: '   ' })).rejects.toThrow(TypeError)
  expect(session.setGoal).not.toHaveBeenCalled()
})

describe('goal attached to a message', () => {
  it('is validated up front and refused on an engine without goals', () => {
    expect(prepareGoalInput({ objective: ' o ', doneWhen: ['a', ' '] })).toEqual({ objective: 'o', doneWhen: ['a'] })
    expect(() => prepareGoalInput({ objective: '' })).toThrow(TypeError)
    getEngineCapabilities.mockReturnValue(CODEX_CAPABILITIES)
    expect(() => prepareGoalInput({ objective: 'o' })).toThrow(/does not support goals/)
  })

  it('is set on the session that receives the message, drafted for a new conversation', () => {
    const session = goalSession()
    const goal = setGoalForTurn(SPACE, CONV, session as never, { objective: 'o', doneWhen: [] }, false)

    expect(session.setGoal).toHaveBeenCalledWith({ objective: 'o', doneWhen: [] })
    expect(emitAgentEvent).toHaveBeenCalledWith('agent:goal-updated', SPACE, CONV, { goal, source: 'user', seenByModel: false })
    const options: Record<string, unknown> = {}
    applyGoalDraft(options, CONV)
    expect(options.goal).toEqual({ objective: 'o', doneWhen: [] })
  })

  it('leaves no draft for a resumed conversation', () => {
    setGoalForTurn(SPACE, CONV, goalSession() as never, { objective: 'o' }, true)
    const options: Record<string, unknown> = {}
    applyGoalDraft(options, CONV)
    expect(options.goal).toBeUndefined()
  })
})

describe('conversations outside the space', () => {
  it('reads an unknown id as no goal and refuses to set one, leaving no draft', async () => {
    getConversation.mockReturnValue(null)
    const digitalHuman = goalSession({ objective: 'Theirs', doneWhen: [], status: 'active', updatedBy: 'agent', updatedAt: 'x' })
    v2Sessions.set('app-chat:app-1', { session: digitalHuman })

    expect(await getConversationGoal(SPACE, 'app-chat:app-1')).toBeNull()
    await expect(setConversationGoal(SPACE, 'app-chat:app-1', { objective: 'Mine' })).rejects.toThrow(/not found/)
    expect(digitalHuman.getGoal).not.toHaveBeenCalled()
    expect(digitalHuman.setGoal).not.toHaveBeenCalled()
    expect(ensureSessionWarm).not.toHaveBeenCalled()
    expect(emitAgentEvent).not.toHaveBeenCalled()

    const options: Record<string, unknown> = {}
    applyGoalDraft(options, 'app-chat:app-1')
    expect(options.goal).toBeUndefined()
  })
})

describe('draft seeding', () => {
  it('does not seed a session of an engine without goals', () => {
    setGoalDraft(CONV, { objective: 'Ship', doneWhen: [], status: 'active', updatedBy: 'user', updatedAt: 'x' })
    getEngineCapabilities.mockReturnValue(ANTHROPIC_CAPABILITIES)
    const options: Record<string, unknown> = {}
    applyGoalDraft(options, CONV)
    expect(options.goal).toBeUndefined()

    getEngineCapabilities.mockReturnValue(HALO_CAPABILITIES)
    applyGoalDraft(options, CONV)
    expect(options.goal).toEqual({ objective: 'Ship', doneWhen: [] })
  })
})
