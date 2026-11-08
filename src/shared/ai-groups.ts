/**
 * Load-balancing group rules shared by the main process, which stores and
 * enforces groups, and the renderer, which edits and explains them. Pure: no
 * I/O, no Electron.
 */

import { isAnthropicProvider } from './constants/providers'
import {
  AVAILABLE_MODELS,
  getSourceAccountName,
  isSourceConfigured,
  type AIGroup,
  type AIGroupMember,
  type AIGroupStrategy,
  type AISource,
  type ModelOption,
} from './types/ai-sources'

export type RestReasonName = 'quota' | 'auth' | 'rate' | 'unavailable' | 'transient'

export const MAX_GROUP_MEMBERS = 10
export const MAX_GROUPS = 20
export const MAX_GROUP_NAME_LENGTH = 60
export const GROUP_STRATEGIES: readonly AIGroupStrategy[] = ['priority', 'spread']
export const DEFAULT_GROUP_STRATEGY: AIGroupStrategy = 'priority'

/** Identity of a member in health records, routing facts and UI keys. */
export function groupMemberKey(member: AIGroupMember): string {
  return `${member.sourceId}\u0000${member.modelId}`
}

/**
 * The models a picker offers for an account: its own list, else the vendor's
 * defaults for Anthropic, else just its current model.
 */
export function listSourceModels(source: AISource): ModelOption[] {
  if (source.availableModels && source.availableModels.length > 0) return source.availableModels
  if (isAnthropicProvider(source.provider)) return AVAILABLE_MODELS
  if (source.model) return [{ id: source.model, name: source.model }]
  return []
}

/**
 * A model of a group as people name it: its account (with who is signed in, so
 * two accounts of one vendor stay apart) and the model's display name.
 */
export function describeGroupMember(
  source: AISource | null | undefined,
  modelId: string
): { account: string; model: string } {
  if (!source) return { account: 'Removed account', model: modelId }
  const accountName = getSourceAccountName(source)
  const name = source.name || source.provider
  return {
    account: accountName ? `${name} · ${accountName}` : name,
    model: source.availableModels?.find(model => model.id === modelId)?.name || modelId,
  }
}

/**
 * Whether an account can take part in a group. The Claude Code CLI account
 * holds no credential Halo can send, so a router-side group cannot use it; an
 * account that is not signed in or has no key cannot serve a request.
 */
export function isSourceGroupEligible(source: AISource): boolean {
  return source.authType !== 'delegated' && isSourceConfigured(source)
}

export type GroupIssueCode =
  | 'invalid-input'
  | 'name-empty'
  | 'name-too-long'
  | 'name-duplicate'
  | 'invalid-strategy'
  | 'no-members'
  | 'too-many-members'
  | 'too-many-groups'
  | 'invalid-member'
  | 'duplicate-member'
  | 'unknown-source'
  | 'unsupported-source'
  | 'unknown-model'

export interface GroupIssue {
  code: GroupIssueCode
  /** Position of the offending member, when the issue is about one. */
  memberIndex?: number
}

export interface GroupInput {
  name: string
  strategy: AIGroupStrategy
  members: AIGroupMember[]
}

export type GroupValidation = { ok: true; value: GroupInput } | { ok: false; issue: GroupIssue }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

function nameKey(name: string): string {
  return normalizeName(name).toLocaleLowerCase()
}

/**
 * Check what a client sent to create or edit a group and return it cleaned.
 *
 * `editing` is the stored group being edited: its own name is not a duplicate,
 * and a member it already holds stays valid when its model has since left the
 * account's list — saving an unrelated change must not fail on that.
 */
export function validateGroupInput(
  input: unknown,
  sources: readonly AISource[],
  groups: readonly AIGroup[],
  editing?: AIGroup
): GroupValidation {
  if (!input || typeof input !== 'object') return { ok: false, issue: { code: 'invalid-input' } }
  if (!editing && groups.length >= MAX_GROUPS) return { ok: false, issue: { code: 'too-many-groups' } }
  const raw = input as Record<string, unknown>

  if (typeof raw.name !== 'string') return { ok: false, issue: { code: 'name-empty' } }
  const name = normalizeName(raw.name)
  if (name.length === 0) return { ok: false, issue: { code: 'name-empty' } }
  if (name.length > MAX_GROUP_NAME_LENGTH) return { ok: false, issue: { code: 'name-too-long' } }
  const key = nameKey(name)
  if (groups.some(group => group.id !== editing?.id && nameKey(group.name) === key)) {
    return { ok: false, issue: { code: 'name-duplicate' } }
  }

  const strategy = raw.strategy === undefined ? DEFAULT_GROUP_STRATEGY : raw.strategy
  if (!GROUP_STRATEGIES.includes(strategy as AIGroupStrategy)) return { ok: false, issue: { code: 'invalid-strategy' } }

  if (!Array.isArray(raw.members)) return { ok: false, issue: { code: 'invalid-input' } }
  if (raw.members.length === 0) return { ok: false, issue: { code: 'no-members' } }
  if (raw.members.length > MAX_GROUP_MEMBERS) return { ok: false, issue: { code: 'too-many-members' } }

  const held = new Set((editing?.members ?? []).map(groupMemberKey))
  const seen = new Set<string>()
  const members: AIGroupMember[] = []
  for (const [memberIndex, entry] of raw.members.entries()) {
    const candidate = entry as Partial<AIGroupMember> | null
    if (!candidate || !isNonEmptyString(candidate.sourceId) || !isNonEmptyString(candidate.modelId)) {
      return { ok: false, issue: { code: 'invalid-member', memberIndex } }
    }
    const member: AIGroupMember = { sourceId: candidate.sourceId, modelId: candidate.modelId }
    const memberKey = groupMemberKey(member)
    if (seen.has(memberKey)) return { ok: false, issue: { code: 'duplicate-member', memberIndex } }
    seen.add(memberKey)

    const source = sources.find(item => item.id === member.sourceId)
    if (!source) return { ok: false, issue: { code: 'unknown-source', memberIndex } }
    // A member the group already holds is kept even if its account has since signed out.
    if (!held.has(memberKey) && !isSourceGroupEligible(source)) {
      return { ok: false, issue: { code: 'unsupported-source', memberIndex } }
    }
    if (source.authType === 'delegated') return { ok: false, issue: { code: 'unsupported-source', memberIndex } }
    if (!held.has(memberKey) && !listSourceModels(source).some(model => model.id === member.modelId)) {
      return { ok: false, issue: { code: 'unknown-model', memberIndex } }
    }
    members.push(member)
  }

  return { ok: true, value: { name, strategy: strategy as AIGroupStrategy, members } }
}

/**
 * Stored groups as the app may rely on them. A hand-edited or damaged entry is
 * dropped rather than allowed to break every reader; ids stay unique.
 */
export function normalizeGroups(raw: unknown, now: string = new Date().toISOString()): AIGroup[] {
  if (!Array.isArray(raw)) return []
  const ids = new Set<string>()
  const groups: AIGroup[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (!isNonEmptyString(item.id) || ids.has(item.id)) continue
    if (typeof item.name !== 'string' || normalizeName(item.name).length === 0) continue
    if (!Array.isArray(item.members)) continue

    const seen = new Set<string>()
    const members: AIGroupMember[] = []
    for (const member of item.members) {
      const candidate = member as Partial<AIGroupMember> | null
      if (!candidate || !isNonEmptyString(candidate.sourceId) || !isNonEmptyString(candidate.modelId)) continue
      const clean: AIGroupMember = { sourceId: candidate.sourceId, modelId: candidate.modelId }
      const memberKey = groupMemberKey(clean)
      if (seen.has(memberKey) || members.length >= MAX_GROUP_MEMBERS) continue
      seen.add(memberKey)
      members.push(clean)
    }

    ids.add(item.id)
    groups.push({
      id: item.id,
      name: normalizeName(item.name).slice(0, MAX_GROUP_NAME_LENGTH),
      strategy: GROUP_STRATEGIES.includes(item.strategy as AIGroupStrategy)
        ? item.strategy as AIGroupStrategy
        : DEFAULT_GROUP_STRATEGY,
      members,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    })
  }
  return groups
}

export function suggestGroupName(base: string, groups: readonly AIGroup[]): string {
  const taken = new Set(groups.map(group => nameKey(group.name)))
  if (!taken.has(nameKey(base))) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(nameKey(candidate))) return candidate
  }
}

/** What one model is known to offer; a missing field is unknown, not zero. */
export interface CapabilityFacts {
  contextWindow?: number
  maxOutputTokens?: number
  vision?: boolean
}

/**
 * What a group can promise whichever member answers: the smallest known
 * context window and output limit, and image input only if no member lacks it.
 * Each limit also names the member that sets it, so an editor can say why.
 */
export interface CapabilityEnvelope {
  contextWindow?: number
  contextWindowSetBy?: number
  maxOutputTokens?: number
  maxOutputTokensSetBy?: number
  /** True when every member accepts images, false when one does not, undefined when only unknowns stand in the way. */
  vision?: boolean
  visionBlockedBy?: number
  /** Members whose context window is not known, so the figure above may be too high. */
  contextWindowUnknown: number[]
}

export function combineCapabilityFacts(facts: readonly CapabilityFacts[]): CapabilityEnvelope {
  const envelope: CapabilityEnvelope = { contextWindowUnknown: [] }
  let visionUnknown = false
  facts.forEach((fact, index) => {
    if (typeof fact.contextWindow === 'number' && fact.contextWindow > 0) {
      if (envelope.contextWindow === undefined || fact.contextWindow < envelope.contextWindow) {
        envelope.contextWindow = fact.contextWindow
        envelope.contextWindowSetBy = index
      }
    } else {
      envelope.contextWindowUnknown.push(index)
    }
    if (typeof fact.maxOutputTokens === 'number' && fact.maxOutputTokens > 0) {
      if (envelope.maxOutputTokens === undefined || fact.maxOutputTokens < envelope.maxOutputTokens) {
        envelope.maxOutputTokens = fact.maxOutputTokens
        envelope.maxOutputTokensSetBy = index
      }
    }
    if (fact.vision === false && envelope.visionBlockedBy === undefined) envelope.visionBlockedBy = index
    if (fact.vision === undefined) visionUnknown = true
  })
  if (facts.length > 0) {
    if (envelope.visionBlockedBy !== undefined) envelope.vision = false
    else if (!visionUnknown) envelope.vision = true
  }
  return envelope
}

/**
 * What the catalog and the user's own settings say about one member, without
 * the preset table only the main process holds. Values it cannot know stay
 * undefined.
 */
export function describeMemberFacts(source: AISource, modelId: string): CapabilityFacts {
  const override = source.modelOverrides?.[modelId]
  const model = source.availableModels?.find(item => item.id === modelId)
  return {
    contextWindow: override?.contextWindow ?? model?.capabilities?.contextWindow,
    maxOutputTokens: override?.maxOutputTokens ?? model?.capabilities?.maxOutputTokens,
    vision: typeof override?.vision === 'boolean' ? override.vision
      : model?.supportsVision !== undefined ? model.supportsVision
        : undefined,
  }
}

/**
 * What an engine session takes from a group when it starts: the figures the
 * group promises. A change in any member's limits, vision or reasoning settings,
 * or in who the members are, changes it; their order, the strategy and every
 * credential do not, because the router reads those on each request.
 */
export function getGroupEnvelopeSignature(group: AIGroup, sources: readonly AISource[] | undefined): string {
  const byId = new Map((sources ?? []).map(source => [source.id, source]))
  const parts = group.members.map(member => {
    const source = byId.get(member.sourceId)
    const override = source?.modelOverrides?.[member.modelId]
    const model = source?.availableModels?.find(item => item.id === member.modelId)
    return [
      member.sourceId, member.modelId, source ? 1 : 0,
      override?.contextWindow, override?.maxOutputTokens, override?.vision,
      override?.reasoningEffort, override?.thinking, override?.adaptiveThinking,
      model?.capabilities?.contextWindow, model?.capabilities?.maxOutputTokens, model?.supportsVision,
    ]
  })
  parts.sort((a, b) => `${a[0]}\u0000${a[1]}`.localeCompare(`${b[0]}\u0000${b[1]}`))
  return JSON.stringify(parts)
}
