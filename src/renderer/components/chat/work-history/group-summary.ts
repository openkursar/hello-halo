/**
 * What one line says about a stretch of work between two things the AI said:
 * the kinds of operation in the order they first came, each with how often
 * ("Ran 5 commands, searched 3 times and read 1 file"), and the step still
 * running. Reasoning and session notices are part of the stretch but not of
 * its summary. Returns i18n keys; the line translates them.
 */

import type { Thought } from '../../../types'
import { TEAM_MCP_SERVER_NAME, TEAM_TOOL_NAMES } from '../../../../shared/apps/team-types'
import { operationStatus } from './operation-status'

// i18n static keys for extraction (DO NOT REMOVE)
// prettier-ignore
void function _i18nWorkKinds(t: (k: string, o: { count: number }) => string) {
  t('Ran {{count}} commands', { count: 0 }); t('Read {{count}} files', { count: 0 }); t('Viewed {{count}} images', { count: 0 }); t('Edited {{count}} files', { count: 0 })
  t('Looked for files {{count}} times', { count: 0 }); t('Searched {{count}} times', { count: 0 }); t('Opened {{count}} web pages', { count: 0 })
  t('Searched the web {{count}} times', { count: 0 }); t('Used the browser {{count}} times', { count: 0 }); t('Used the terminal {{count}} times', { count: 0 })
  t('Started {{count}} collaborators', { count: 0 }); t('Sent {{count}} messages', { count: 0 }); t('Coordinated the team {{count}} times', { count: 0 })
  t('Used {{count}} skills', { count: 0 }); t('Updated the goal {{count}} times', { count: 0 }); t('Asked {{count}} questions', { count: 0 })
  t('Used tools {{count}} times', { count: 0 })
}

export type WorkKind =
  | 'command' | 'read' | 'image' | 'edit' | 'find' | 'search' | 'web-page' | 'web-search'
  | 'browser' | 'terminal' | 'collaborator' | 'message' | 'team' | 'skill' | 'goal' | 'question' | 'tool'

const KIND_KEYS: Record<WorkKind, string> = {
  command: 'Ran {{count}} commands',
  read: 'Read {{count}} files',
  image: 'Viewed {{count}} images',
  edit: 'Edited {{count}} files',
  find: 'Looked for files {{count}} times',
  search: 'Searched {{count}} times',
  'web-page': 'Opened {{count}} web pages',
  'web-search': 'Searched the web {{count}} times',
  browser: 'Used the browser {{count}} times',
  terminal: 'Used the terminal {{count}} times',
  collaborator: 'Started {{count}} collaborators',
  message: 'Sent {{count}} messages',
  team: 'Coordinated the team {{count}} times',
  skill: 'Used {{count}} skills',
  goal: 'Updated the goal {{count}} times',
  question: 'Asked {{count}} questions',
  tool: 'Used tools {{count}} times',
}

const BY_TOOL: Record<string, WorkKind> = {
  Bash: 'command',
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Glob: 'find',
  Grep: 'search',
  WebFetch: 'web-page',
  WebSearch: 'web-search',
  Skill: 'skill',
  Goal: 'goal',
  AskUserQuestion: 'question',
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?)$/i
const TEAM_PREFIX = `mcp__${TEAM_MCP_SERVER_NAME}__`

/** Which kind of work a step counts as in a summary; undefined for reasoning and notices. */
export function workKind(step: Thought): WorkKind | undefined {
  if (step.type === 'tool_result') return 'tool'
  if (step.type !== 'tool_use') return undefined
  const name = step.toolName ?? ''
  if (name === 'Read' && typeof step.toolInput?.file_path === 'string' && IMAGE_FILE.test(step.toolInput.file_path)) return 'image'
  const builtin = BY_TOOL[name]
  if (builtin) return builtin
  if (name.startsWith(TEAM_PREFIX)) {
    const tool = name.slice(TEAM_PREFIX.length)
    if (tool === TEAM_TOOL_NAMES.spawn) return 'collaborator'
    if (tool === TEAM_TOOL_NAMES.send) return 'message'
    return 'team'
  }
  if (name.endsWith('__conversation_send')) return 'message'
  if (name.startsWith('mcp__ai-browser__')) return 'browser'
  if (name.startsWith('mcp__ai-terminal__')) return 'terminal'
  if (name.startsWith('mcp__web-search__')) return 'web-search'
  return 'tool'
}

export interface GroupSummary {
  /** Kinds in the order they first came, each with its count. */
  parts: Array<{ key: string; count: number }>
  /** The operation still running, while the reply runs. */
  running?: Thought
  /** The first counted step: the line's icon, and its whole label when it is the only one. */
  lead?: Thought
  /** How many steps the summary counts. */
  counted: number
}

export function summarizeGroup(steps: readonly Thought[], live: boolean): GroupSummary {
  const counts = new Map<WorkKind, number>()
  let running: Thought | undefined
  let lead: Thought | undefined
  let counted = 0
  for (const step of steps) {
    const kind = workKind(step)
    if (!kind) continue
    // Reasoning in progress is already what the header says ("Working…"); the line names only an operation.
    const status = operationStatus(step, live)
    if (status === 'running' || status === 'generating') running = step
    lead ??= step
    counted++
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return { parts: [...counts].map(([kind, count]) => ({ key: KIND_KEYS[kind], count })), running, lead, counted }
}
