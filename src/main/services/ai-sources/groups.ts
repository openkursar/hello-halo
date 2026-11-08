/**
 * The stored load-balancing groups and the rules for changing them. Groups are
 * edited only through these operations, so a stale settings snapshot cannot revert
 * them (see config.controller); each one validates against the accounts that
 * exist now and saves in one write.
 */

import { v4 as uuidv4 } from 'uuid'
import { getConfig, saveConfig } from '../../foundation/config.service'
import { forgetGroup } from '../../openai-compat-router'
import {
  normalizeGroups,
  validateGroupInput,
  type GroupIssue,
  type GroupIssueCode,
} from '../../../shared/ai-groups'
import {
  createEmptyAISourcesConfig,
  type AIGroup,
  type AISourcesConfig,
} from '../../../shared/types'

const ISSUE_MESSAGES: Record<GroupIssueCode, string> = {
  'invalid-input': 'The group is not valid',
  'name-empty': 'Give the group a name',
  'name-too-long': 'The group name is too long',
  'name-duplicate': 'Another group already has this name',
  'invalid-strategy': 'Unknown way of choosing models',
  'no-members': 'Add at least one model to the group',
  'too-many-members': 'The group has too many models',
  'too-many-groups': 'There are already as many groups as are allowed',
  'invalid-member': 'One of the models is not valid',
  'duplicate-member': 'The same model is listed twice',
  'unknown-source': 'One of the accounts no longer exists',
  'unsupported-source': 'One of the accounts cannot be used in a group',
  'unknown-model': 'One of the models is not offered by its account',
}

export class GroupError extends Error {
  constructor(readonly code: GroupIssueCode | 'not-found', readonly memberIndex?: number) {
    super(code === 'not-found' ? 'This group no longer exists' : ISSUE_MESSAGES[code])
    this.name = 'GroupError'
  }
}

function readAiSources(): AISourcesConfig {
  const aiSources = (getConfig() as { aiSources?: AISourcesConfig }).aiSources
  return aiSources?.version === 2 && Array.isArray(aiSources.sources) ? aiSources : createEmptyAISourcesConfig()
}

function write(next: AISourcesConfig): AISourcesConfig {
  saveConfig({ aiSources: next } as never)
  return next
}

function reject(issue: GroupIssue): never {
  console.warn(`[AIGroups] Rejected group change: ${issue.code}${issue.memberIndex !== undefined ? ` member=${issue.memberIndex}` : ''}`)
  throw new GroupError(issue.code, issue.memberIndex)
}

/** The stored groups, repaired of anything damaged. */
export function listGroups(): AIGroup[] {
  return normalizeGroups(readAiSources().groups)
}

export function getGroup(groupId: string): AIGroup | null {
  return listGroups().find(group => group.id === groupId) ?? null
}

export function createGroup(input: unknown): { aiSources: AISourcesConfig; group: AIGroup } {
  const aiSources = readAiSources()
  const groups = normalizeGroups(aiSources.groups)
  const checked = validateGroupInput(input, aiSources.sources, groups)
  if (!checked.ok) reject(checked.issue)

  const now = new Date().toISOString()
  let id = uuidv4()
  while (aiSources.sources.some(source => source.id === id)) id = uuidv4()
  const group: AIGroup = { id, ...checked.value, createdAt: now, updatedAt: now }
  console.log(`[AIGroups] Created group=${id} members=${group.members.length} strategy=${group.strategy}`)
  return { aiSources: write({ ...aiSources, groups: [...groups, group] }), group }
}

export function updateGroup(groupId: string, input: unknown): { aiSources: AISourcesConfig; group: AIGroup } {
  const aiSources = readAiSources()
  const groups = normalizeGroups(aiSources.groups)
  const existing = groups.find(group => group.id === groupId)
  if (!existing) throw new GroupError('not-found')
  const checked = validateGroupInput(input, aiSources.sources, groups, existing)
  if (!checked.ok) reject(checked.issue)

  const group: AIGroup = { ...existing, ...checked.value, updatedAt: new Date().toISOString() }
  console.log(`[AIGroups] Updated group=${groupId} members=${group.members.length} strategy=${group.strategy}`)
  return {
    aiSources: write({ ...aiSources, groups: groups.map(item => (item.id === groupId ? group : item)) }),
    group,
  }
}

export function deleteGroup(groupId: string): { aiSources: AISourcesConfig } {
  const aiSources = readAiSources()
  const groups = normalizeGroups(aiSources.groups)
  if (!groups.some(group => group.id === groupId)) throw new GroupError('not-found')

  const { currentGroupId, ...rest } = aiSources
  const next: AISourcesConfig = {
    ...rest,
    groups: groups.filter(group => group.id !== groupId),
    ...(currentGroupId && currentGroupId !== groupId ? { currentGroupId } : {}),
  }
  forgetGroup(groupId)
  console.log(`[AIGroups] Deleted group=${groupId}`)
  return { aiSources: write(next) }
}

/** The group new conversations start on. The selected account is left as it is. */
export function selectGroup(groupId: string): AISourcesConfig {
  const aiSources = readAiSources()
  if (!normalizeGroups(aiSources.groups).some(group => group.id === groupId)) throw new GroupError('not-found')
  if (aiSources.currentGroupId === groupId) return aiSources
  return write({ ...aiSources, currentGroupId: groupId })
}
