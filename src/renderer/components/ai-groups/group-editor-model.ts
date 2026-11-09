/**
 * The group editor's working copy and the pure rules for changing it; whether a
 * draft may be saved is the shared validation's call.
 */

import {
  DEFAULT_GROUP_STRATEGY,
  MAX_GROUP_MEMBERS,
  combineCapabilityFacts,
  describeMemberFacts,
  groupMemberKey,
  isSourceGroupEligible,
  listSourceModels,
  suggestGroupName,
  type CapabilityFacts,
} from '../../../shared/ai-groups'
import type {
  AIGroup,
  AIGroupMember,
  AIGroupStrategy,
  AISource,
  ModelOption,
} from '../../../shared/types/ai-sources'
import { getSourceAccountName } from '../../../shared/types/ai-sources'

export interface GroupDraft {
  name: string
  strategy: AIGroupStrategy
  members: AIGroupMember[]
}

export function newGroupDraft(groups: readonly AIGroup[], baseName: string): GroupDraft {
  return { name: suggestGroupName(baseName, groups), strategy: DEFAULT_GROUP_STRATEGY, members: [] }
}

export function draftOfGroup(group: AIGroup): GroupDraft {
  return { name: group.name, strategy: group.strategy, members: group.members.map(member => ({ ...member })) }
}

/** Adds models the draft does not hold yet, up to the group limit; the draft itself when nothing is added. */
export function appendMembers(draft: GroupDraft, additions: readonly AIGroupMember[]): GroupDraft {
  const held = new Set(draft.members.map(groupMemberKey))
  const added: AIGroupMember[] = []
  for (const member of additions) {
    if (draft.members.length + added.length >= MAX_GROUP_MEMBERS) break
    const key = groupMemberKey(member)
    if (held.has(key)) continue
    held.add(key)
    added.push({ sourceId: member.sourceId, modelId: member.modelId })
  }
  return added.length > 0 ? { ...draft, members: [...draft.members, ...added] } : draft
}

export function removeMemberAt(draft: GroupDraft, index: number): GroupDraft {
  if (index < 0 || index >= draft.members.length) return draft
  return { ...draft, members: draft.members.filter((_, position) => position !== index) }
}

/** Moves a model to a new position in the order; the draft itself when it would stay where it is. */
export function moveMember(draft: GroupDraft, from: number, to: number): GroupDraft {
  const last = draft.members.length - 1
  if (from < 0 || from > last || to < 0 || to > last || from === to) return draft
  const members = [...draft.members]
  const [moved] = members.splice(from, 1)
  members.splice(to, 0, moved)
  return { ...draft, members }
}

export type SkipReason = 'cli-account' | 'not-signed-in' | 'no-model' | 'model-unavailable' | 'limit'

export interface CurrentModelPlan {
  members: AIGroupMember[]
  skipped: Array<{ sourceId: string; name: string; reason: SkipReason }>
}

function accountName(source: AISource): string {
  return source.name || source.provider
}

function skipReasonOf(source: AISource): SkipReason | null {
  if (source.authType === 'delegated') return 'cli-account'
  if (!isSourceGroupEligible(source)) return 'not-signed-in'
  if (!source.model) return 'no-model'
  if (!listSourceModels(source).some(model => model.id === source.model)) return 'model-unavailable'
  return null
}

/**
 * "Use each account's current model": every account that can serve takes the
 * model it is set to, the account in use first and the rest in list order.
 * Accounts that cannot are reported with why, never silently left out.
 */
export function planCurrentModels(sources: readonly AISource[], currentId: string | null | undefined): CurrentModelPlan {
  const ordered = currentId
    ? [...sources.filter(source => source.id === currentId), ...sources.filter(source => source.id !== currentId)]
    : [...sources]
  const plan: CurrentModelPlan = { members: [], skipped: [] }
  for (const source of ordered) {
    const reason = skipReasonOf(source)
    if (reason) plan.skipped.push({ sourceId: source.id, name: accountName(source), reason })
    else plan.members.push({ sourceId: source.id, modelId: source.model })
  }
  return plan
}

export interface FilledDraft {
  draft: GroupDraft
  /** Accounts that gave nothing, each with why. */
  skipped: CurrentModelPlan['skipped']
  /** Whether anything was added. */
  added: boolean
}

/**
 * "Use each account's current model" applied to a draft: what is missing is
 * appended after what is there, and every account that gave nothing is
 * accounted for, including those the group had no room left for.
 */
export function fillCurrentModels(draft: GroupDraft, sources: readonly AISource[], currentId: string | null | undefined): FilledDraft {
  const plan = planCurrentModels(sources, currentId)
  const next = appendMembers(draft, plan.members)
  const before = new Set(draft.members.map(groupMemberKey))
  const after = new Set(next.members.map(groupMemberKey))
  const skipped = [...plan.skipped]
  for (const member of plan.members) {
    const key = groupMemberKey(member)
    if (before.has(key) || after.has(key)) continue
    const source = sources.find(item => item.id === member.sourceId)
    skipped.push({ sourceId: member.sourceId, name: source ? accountName(source) : member.sourceId, reason: 'limit' })
  }
  return { draft: next, skipped, added: next !== draft }
}

export type CapabilityNote =
  | { kind: 'context-limit'; tokens: number; member: AIGroupMember }
  | { kind: 'context-unconfirmed'; count: number }
  | { kind: 'images-off'; member: AIGroupMember }
  | { kind: 'images-unconfirmed'; count: number }

/**
 * What a group gives up by mixing these models: it promises only what every
 * model offers. Reported only where the models differ, so a group of equals
 * says nothing, and what the catalogs do not state is called unconfirmed
 * instead of being taken as supported.
 */
export function groupCapabilityNotes(members: readonly AIGroupMember[], sources: readonly AISource[]): CapabilityNote[] {
  if (members.length < 2) return []
  const facts: CapabilityFacts[] = members.map(member => {
    const source = sources.find(item => item.id === member.sourceId)
    return source ? describeMemberFacts(source, member.modelId) : {}
  })
  const envelope = combineCapabilityFacts(facts)
  const notes: CapabilityNote[] = []

  const largest = Math.max(0, ...facts.map(fact => fact.contextWindow ?? 0))
  if (envelope.contextWindow !== undefined && envelope.contextWindowSetBy !== undefined && largest > envelope.contextWindow) {
    notes.push({ kind: 'context-limit', tokens: envelope.contextWindow, member: members[envelope.contextWindowSetBy] })
  }
  if (envelope.contextWindow !== undefined && envelope.contextWindowUnknown.length > 0) {
    notes.push({ kind: 'context-unconfirmed', count: envelope.contextWindowUnknown.length })
  }

  const someSeeImages = facts.some(fact => fact.vision === true)
  if (envelope.vision === false && envelope.visionBlockedBy !== undefined && someSeeImages) {
    notes.push({ kind: 'images-off', member: members[envelope.visionBlockedBy] })
  } else if (envelope.vision === undefined && someSeeImages) {
    notes.push({ kind: 'images-unconfirmed', count: facts.filter(fact => fact.vision === undefined).length })
  }
  return notes
}

export interface PickerAccount {
  source: AISource
  /** Why the account cannot be part of a group; absent when it can. */
  unusable?: 'cli-account' | 'not-signed-in'
  /** The models to offer, narrowed by the search. */
  models: ModelOption[]
}

function searchText(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').toLocaleLowerCase()
}

function matchesAll(text: string, words: readonly string[]): boolean {
  return words.every(word => text.includes(word))
}

/**
 * The accounts and models the "add a model" panel offers for a search. Words
 * may name the account, the model or both ("claude sonnet"). Accounts that
 * cannot join a group are kept, after the ones that can, so the panel can say
 * why they are missing instead of leaving people to wonder.
 */
export function pickerAccounts(sources: readonly AISource[], query: string): PickerAccount[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const accounts: PickerAccount[] = []
  for (const source of sources) {
    const unusable: PickerAccount['unusable'] = source.authType === 'delegated'
      ? 'cli-account'
      : isSourceGroupEligible(source) ? undefined : 'not-signed-in'
    const all = listSourceModels(source)
    const accountText = searchText(source.name, source.provider, getSourceAccountName(source))
    const models = words.length === 0
      ? all
      : all.filter(model => matchesAll(`${accountText} ${searchText(model.name, model.id)}`, words))
    if (words.length > 0 && models.length === 0 && !(unusable && matchesAll(accountText, words))) continue
    accounts.push({ source, ...(unusable ? { unusable } : {}), models })
  }
  return [...accounts.filter(account => !account.unusable), ...accounts.filter(account => account.unusable)]
}
