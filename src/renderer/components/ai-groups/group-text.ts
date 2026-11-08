/**
 * The words the group screens use. Each function takes the translator so the
 * strings stay plain `t('English')` calls the extractor can see.
 */

import { MAX_GROUPS, MAX_GROUP_MEMBERS, MAX_GROUP_NAME_LENGTH, describeGroupMember, isSourceGroupEligible, type GroupIssue } from '../../../shared/ai-groups'
import type { AIGroupMember, AISource } from '../../../shared/types/ai-sources'
import type { GroupMemberHealth, GroupRouteInfo } from '../../../shared/types/ai-groups-runtime'
import type { CapabilityNote, SkipReason } from './group-editor-model'

export type Translate = (text: string, options?: Record<string, unknown>) => string

/** "Name · Auto", the way a group is named in the header and in lists. */
export function groupTitle(name: string, t: Translate): string {
  return `${name} · ${t('Auto')}`
}

export type MemberProblem = 'removed' | 'signed-out'

/** A model of a group as a person reads it, and what keeps it from serving, if anything. */
export function memberNames(
  source: AISource | null | undefined,
  modelId: string,
  t: Translate
): { account: string; model: string; problem: MemberProblem | null } {
  if (!source) return { account: t('Removed account'), model: modelId, problem: 'removed' }
  return { ...describeGroupMember(source, modelId), problem: isSourceGroupEligible(source) ? null : 'signed-out' }
}

export function describeMemberProblem(problem: MemberProblem, t: Translate): string {
  return problem === 'removed' ? t('This account was removed') : t('Not signed in')
}

/** A model as one line: "Account / Model". */
export function memberLine(source: AISource | null | undefined, modelId: string, t: Translate): string {
  const { account, model } = memberNames(source, modelId, t)
  return `${account} / ${model}`
}

/** A tokens figure the way people read it: 128K, 1M. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}K`
}

/**
 * Why a change was refused. Codes come from the shared validation (also run on
 * the main side) plus the few the transport adds; `model` names the entry an
 * issue is about, when there is one.
 */
export function describeGroupIssue(code: string | undefined, t: Translate, model?: string): string {
  switch (code as GroupIssue['code'] | 'not-found' | undefined) {
    case 'name-empty': return t('Give the group a name.')
    case 'name-too-long': return t('Use a shorter name (up to {{max}} characters).', { max: MAX_GROUP_NAME_LENGTH })
    case 'name-duplicate': return t('Another group already has this name.')
    case 'no-members': return t('Add at least one model.')
    case 'too-many-members': return t('A group can hold up to {{max}} models.', { max: MAX_GROUP_MEMBERS })
    case 'too-many-groups': return t('You can have up to {{max}} groups.', { max: MAX_GROUPS })
    case 'duplicate-member': return model ? t('{{model}} is already in the group.', { model }) : t('A model appears twice in the group.')
    case 'unknown-source': return model ? t('The account of {{model}} was removed.', { model }) : t('One of the accounts was removed.')
    case 'unsupported-source': return model ? t('{{model}} cannot be used in a group.', { model }) : t('One of the accounts cannot be used in a group.')
    case 'unknown-model': return model ? t('{{model}} is no longer offered by its account.', { model }) : t('One of the models is no longer offered by its account.')
    case 'not-found': return t('This group no longer exists.')
    default: return t('The group could not be saved. Please try again.')
  }
}

export function describeSkip(reason: SkipReason, name: string, t: Translate): string {
  switch (reason) {
    case 'cli-account': return t('{{name}} signs in through Claude Code, which groups cannot use', { name })
    case 'not-signed-in': return t('{{name}} is not signed in', { name })
    case 'no-model': return t('{{name}} has no model selected', { name })
    case 'model-unavailable': return t('The model {{name}} uses is no longer offered', { name })
    case 'limit': return t('{{name}} was not added: a group holds up to {{max}} models', { name, max: MAX_GROUP_MEMBERS })
  }
}

/** Why an account is listed but cannot be chosen. */
export function describeUnusable(reason: 'cli-account' | 'not-signed-in', t: Translate): string {
  return reason === 'cli-account'
    ? t('Signs in through Claude Code, which groups cannot use')
    : t('Not signed in')
}

export function describeCapabilityNote(note: CapabilityNote, t: Translate, label: (member: AIGroupMember) => string): string {
  switch (note.kind) {
    case 'context-limit':
      return t('Conversations in this group are limited to {{size}} because of {{model}}.', { size: formatTokenCount(note.tokens), model: label(note.member) })
    case 'context-unconfirmed':
      return t('The context size of {{count}} of the models is not confirmed, so the limit may be lower.', { count: note.count })
    case 'images-off':
      return t('Image input is off for this group because {{model}} cannot read images. Remove it to keep image input.', { model: label(note.member) })
    case 'images-unconfirmed':
      return t('Image input is not confirmed for {{count}} of the models, so images may fail.', { count: note.count })
  }
}

/** "in a moment", "in 5 minutes", "in 2 hours": when a resting model is expected to be tried again. */
export function formatRetryIn(until: number, now: number, language: string, t: Translate): string {
  const seconds = Math.max(0, Math.round((until - now) / 1000))
  if (seconds < 60) return t('in a moment')
  const minutes = Math.ceil(seconds / 60)
  const relative = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  return minutes < 60 ? relative.format(minutes, 'minute') : relative.format(Math.ceil(minutes / 60), 'hour')
}

/** What a model that is not simply ready is doing, or null when it is ready. */
export function describeRest(health: GroupMemberHealth, now: number, language: string, t: Translate): string | null {
  if (health.state === 'ready') return null
  if (health.state === 'half-open') return t('Checking again')
  const when = health.until !== undefined ? formatRetryIn(health.until, now, language, t) : null
  switch (health.reason) {
    case 'quota': return when ? t('Usage limit reached · available again {{when}}', { when }) : t('Usage limit reached')
    case 'rate': return when ? t('Too many requests · trying again {{when}}', { when }) : t('Too many requests')
    case 'auth': return t('Needs attention · check this account’s sign-in or key')
    case 'unavailable': return when ? t('Model unavailable · checking again {{when}}', { when }) : t('Model unavailable')
    default: return when ? t('Not responding · trying again {{when}}', { when }) : t('Not responding')
  }
}

export type RouteView =
  | { kind: 'idle'; caption: string }
  | { kind: 'serving'; caption: string; member: { account: string; model: string } }
  | { kind: 'switching'; caption: string; member: { account: string; model: string } }
  | { kind: 'exhausted'; caption: string }

/**
 * What to tell a person about where a conversation's group is sending it. A
 * conversation the router has not served this run says so plainly, rather than
 * guessing from the group's order. A switch is news only while the reply that
 * caused it is still being waited for (`live`); once that stopped, the model
 * that was being tried is unknown and the next send chooses again.
 */
export function describeRoute(route: GroupRouteInfo | null, t: Translate, live = false): RouteView {
  if (!route) return { kind: 'idle', caption: t('Picked automatically when you send') }
  switch (route.state) {
    case 'serving':
      return route.member
        ? { kind: 'serving', caption: t('In use for this chat'), member: route.member.label }
        : { kind: 'idle', caption: t('Picked automatically when you send') }
    case 'switching':
      return route.member && live
        ? { kind: 'switching', caption: t('Trying another model'), member: route.member.label }
        : { kind: 'idle', caption: t('Picked automatically when you send') }
    case 'exhausted':
      return { kind: 'exhausted', caption: t('No model is available right now') }
  }
}
