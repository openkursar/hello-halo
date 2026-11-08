/**
 * The words the group screens use. The translator here fills in {{values}} the
 * way the real one does and otherwise leaves the English as written.
 */

import { describe, expect, it } from 'vitest'
import {
  describeCapabilityNote,
  describeGroupIssue,
  describeMemberProblem,
  describeRest,
  describeRoute,
  describeSkip,
  describeUnusable,
  formatRetryIn,
  formatTokenCount,
  groupTitle,
  memberLine,
  memberNames,
  type Translate,
} from '../../../src/renderer/components/ai-groups/group-text'
import { MAX_GROUPS, MAX_GROUP_MEMBERS, MAX_GROUP_NAME_LENGTH } from '../../../src/shared/ai-groups'
import type { AISource } from '../../../src/shared/types/ai-sources'
import type { GroupRouteInfo } from '../../../src/shared/types/ai-groups-runtime'

const t: Translate = (text, options = {}) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ''))
const NOW = 1_000_000

describe('naming', () => {
  it('marks a group as automatic wherever it is named', () => {
    expect(groupTitle('Daily', t)).toBe('Daily · Auto')
  })

  it('writes a model as account and model', () => {
    const source = { id: 'a', name: 'Claude', provider: 'anthropic', availableModels: [{ id: 'm', name: 'Sonnet' }] } as unknown as AISource
    expect(memberLine(source, 'm', t)).toBe('Claude / Sonnet')
    expect(memberLine(null, 'm', t)).toBe('Removed account / m')
  })

  it('tells apart a model that can serve, one whose account signed out, and one whose account is gone', () => {
    const source = { id: 'a', name: 'Claude', provider: 'anthropic', authType: 'api-key', apiKey: 'k', model: 'm', availableModels: [{ id: 'm', name: 'Sonnet' }] } as unknown as AISource
    expect(memberNames(source, 'm', t)).toEqual({ account: 'Claude', model: 'Sonnet', problem: null })
    expect(memberNames({ ...source, apiKey: '' }, 'm', t)).toMatchObject({ problem: 'signed-out' })
    expect(memberNames(undefined, 'm', t)).toEqual({ account: 'Removed account', model: 'm', problem: 'removed' })
    expect(describeMemberProblem('signed-out', t)).toBe('Not signed in')
    expect(describeMemberProblem('removed', t)).toBe('This account was removed')
  })

  it('writes sizes the way people read them', () => {
    expect(formatTokenCount(128_000)).toBe('128K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
  })
})

describe('why a change was refused', () => {
  it.each([
    ['name-empty', 'Give the group a name.'],
    ['name-too-long', `Use a shorter name (up to ${MAX_GROUP_NAME_LENGTH} characters).`],
    ['name-duplicate', 'Another group already has this name.'],
    ['no-members', 'Add at least one model.'],
    ['too-many-members', `A group can hold up to ${MAX_GROUP_MEMBERS} models.`],
    ['too-many-groups', `You can have up to ${MAX_GROUPS} groups.`],
    ['not-found', 'This group no longer exists.'],
  ])('says %s plainly', (code, text) => {
    expect(describeGroupIssue(code, t)).toBe(text)
  })

  it('points at the model an issue is about', () => {
    expect(describeGroupIssue('unknown-model', t, 'A / M')).toBe('A / M is no longer offered by its account.')
    expect(describeGroupIssue('unsupported-source', t, 'A / M')).toBe('A / M cannot be used in a group.')
    expect(describeGroupIssue('unknown-source', t, 'A / M')).toBe('The account of A / M was removed.')
    expect(describeGroupIssue('duplicate-member', t, 'A / M')).toBe('A / M is already in the group.')
  })

  it('still says something useful when it cannot tell which model', () => {
    expect(describeGroupIssue('unknown-model', t)).toContain('One of the models')
    expect(describeGroupIssue('unsupported-source', t)).toContain('One of the accounts')
  })

  it('does not blame the person for a failure it cannot explain', () => {
    expect(describeGroupIssue(undefined, t)).toBe('The group could not be saved. Please try again.')
    expect(describeGroupIssue('something-new', t)).toBe('The group could not be saved. Please try again.')
  })

  it('explains each reason an account was skipped or cannot be chosen', () => {
    expect(describeSkip('cli-account', 'CLI', t)).toContain('CLI signs in through Claude Code')
    expect(describeSkip('not-signed-in', 'X', t)).toBe('X is not signed in')
    expect(describeSkip('no-model', 'X', t)).toBe('X has no model selected')
    expect(describeSkip('model-unavailable', 'X', t)).toContain('no longer offered')
    expect(describeSkip('limit', 'X', t)).toBe(`X was not added: a group holds up to ${MAX_GROUP_MEMBERS} models`)
    expect(describeUnusable('cli-account', t)).toContain('Claude Code')
    expect(describeUnusable('not-signed-in', t)).toBe('Not signed in')
  })
})

describe('the limits of a mixed group', () => {
  const label = (member: { sourceId: string; modelId: string }) => `${member.sourceId}/${member.modelId}`

  it('names the size and the model that sets it', () => {
    expect(describeCapabilityNote({ kind: 'context-limit', tokens: 128_000, member: { sourceId: 'a', modelId: 'm' } }, t, label))
      .toBe('Conversations in this group are limited to 128K because of a/m.')
  })

  it('says what is not confirmed rather than promising it', () => {
    expect(describeCapabilityNote({ kind: 'context-unconfirmed', count: 2 }, t, label)).toContain('2 of the models is not confirmed')
    expect(describeCapabilityNote({ kind: 'images-unconfirmed', count: 1 }, t, label)).toContain('not confirmed for 1 of the models')
  })

  it('tells how to keep image input', () => {
    expect(describeCapabilityNote({ kind: 'images-off', member: { sourceId: 'a', modelId: 'm' } }, t, label)).toContain('Remove it to keep image input')
  })
})

describe('when a resting model is tried again', () => {
  it('says in a moment for less than a minute', () => {
    expect(formatRetryIn(NOW + 20_000, NOW, 'en', t)).toBe('in a moment')
    expect(formatRetryIn(NOW - 5_000, NOW, 'en', t)).toBe('in a moment')
  })

  it('counts minutes up, then hours', () => {
    expect(formatRetryIn(NOW + 61_000, NOW, 'en', t)).toBe('in 2 minutes')
    expect(formatRetryIn(NOW + 5 * 60_000, NOW, 'en', t)).toBe('in 5 minutes')
    expect(formatRetryIn(NOW + 61 * 60_000, NOW, 'en', t)).toBe('in 2 hours')
  })

  it('speaks the language the app is in', () => {
    expect(formatRetryIn(NOW + 5 * 60_000, NOW, 'zh-CN', t)).toBe('5分钟后')
  })
})

describe('what a model that is not ready is doing', () => {
  const rest = (reason: 'quota' | 'rate' | 'auth' | 'unavailable' | 'transient', until?: number) =>
    describeRest({ sourceId: 'a', modelId: 'm', state: 'resting', reason, until }, NOW, 'en', t)

  it('says nothing about a model that is ready', () => {
    expect(describeRest({ sourceId: 'a', modelId: 'm', state: 'ready' }, NOW, 'en', t)).toBeNull()
  })

  it('names the reason and when it expects to try again', () => {
    expect(rest('quota', NOW + 10 * 60_000)).toBe('Usage limit reached · available again in 10 minutes')
    expect(rest('rate', NOW + 10_000)).toBe('Too many requests · trying again in a moment')
    expect(rest('unavailable', NOW + 3_600_000)).toBe('Model unavailable · checking again in 1 hour')
    expect(rest('transient', NOW + 60_000)).toBe('Not responding · trying again in 1 minute')
  })

  it('does not invent a time it was not given', () => {
    expect(rest('quota')).toBe('Usage limit reached')
    expect(rest('rate')).toBe('Too many requests')
    expect(rest('unavailable')).toBe('Model unavailable')
    expect(rest('transient')).toBe('Not responding')
  })

  it('points to the account when the problem is its sign-in or key', () => {
    expect(rest('auth', NOW + 1000)).toContain('check this account')
  })

  it('says a model being probed is being checked again', () => {
    expect(describeRest({ sourceId: 'a', modelId: 'm', state: 'half-open' }, NOW, 'en', t)).toBe('Checking again')
  })
})

describe('where a conversation\'s group is sending it', () => {
  const member = { key: 'k', sourceId: 'a', modelId: 'm', label: { account: 'Backup', model: 'Sonnet' } }
  const route = (state: GroupRouteInfo['state'], withMember = true): GroupRouteInfo =>
    ({ groupId: 'g', sessionKey: 'c', state, at: 1, ...(withMember ? { member } : {}) })

  it('does not guess before the router has served the conversation', () => {
    expect(describeRoute(null, t)).toEqual({ kind: 'idle', caption: 'Picked automatically when you send' })
  })

  it('names the account and model in use', () => {
    expect(describeRoute(route('serving'), t)).toEqual({ kind: 'serving', caption: 'In use for this chat', member: { account: 'Backup', model: 'Sonnet' } })
  })

  it('names the model being tried while the router switches and a reply is awaited', () => {
    expect(describeRoute(route('switching'), t, true)).toEqual({ kind: 'switching', caption: 'Trying another model', member: { account: 'Backup', model: 'Sonnet' } })
  })

  it('does not call a switch live once the wait is over: the model that was tried is unknown, the next send chooses again', () => {
    expect(describeRoute(route('switching'), t, false)).toEqual({ kind: 'idle', caption: 'Picked automatically when you send' })
    expect(describeRoute(route('switching'), t)).toEqual({ kind: 'idle', caption: 'Picked automatically when you send' })
  })

  it('keeps naming the model in use whether or not a reply is awaited', () => {
    expect(describeRoute(route('serving'), t, true).kind).toBe('serving')
    expect(describeRoute(route('serving'), t, false).kind).toBe('serving')
  })

  it('says when no model is available', () => {
    expect(describeRoute(route('exhausted', false), t)).toEqual({ kind: 'exhausted', caption: 'No model is available right now' })
  })

  it('falls back to not knowing when a report names no model', () => {
    expect(describeRoute(route('serving', false), t).kind).toBe('idle')
    expect(describeRoute(route('switching', false), t, true).kind).toBe('idle')
  })
})
