/**
 * How one operation is named in a single line: a short kind ("Command",
 * "Read"), then what it acted on (the command, the file). Returns i18n keys
 * for kinds Halo names itself and the tool's own name for any other tool.
 * A group of operations is summed up in group-summary.
 */

import type { Thought } from '../../../types'
import { displayPath } from '../../../../shared/content-reference'
import { calculateDiffStats } from '../../../../shared/file-changes'
import { FileImage, Globe, Puzzle, Send, TerminalSquare, UserPlus, Users, type LucideIcon } from 'lucide-react'
import { getThoughtIcon, getToolFriendlyFormat } from '../thought-utils'
import { workKind, type WorkKind } from './group-summary'

// i18n static keys for extraction (DO NOT REMOVE)
// prettier-ignore
void function _i18nOperationKinds(t: (k: string) => string) {
  t('Command'); t('Read'); t('Write'); t('Edit'); t('Find'); t('Search'); t('Web page'); t('Web search')
  t('Sub-agent'); t('Skill'); t('Goal'); t('Question'); t('Find tools'); t('Reasoning'); t('System')
  t('Error'); t('Result'); t('Image'); t('Browser'); t('Terminal'); t('Collaborator'); t('Message'); t('Team')
}

const TOOL_KINDS: Record<string, string> = {
  Bash: 'Command',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  Glob: 'Find',
  Grep: 'Search',
  WebFetch: 'Web page',
  WebSearch: 'Web search',
  Task: 'Sub-agent',
  Agent: 'Sub-agent',
  Skill: 'Skill',
  Goal: 'Goal',
  AskUserQuestion: 'Question',
  ToolSearch: 'Find tools',
}

/** Kinds named for a family of tools rather than one tool. */
const FAMILY_KINDS: Partial<Record<WorkKind, string>> = {
  browser: 'Browser',
  terminal: 'Terminal',
  'web-search': 'Web search',
  collaborator: 'Collaborator',
  message: 'Message',
  team: 'Team',
}

/**
 * Icons for tools known by family rather than by name (MCP tools have no entry
 * in the shared tool map and would all read as a generic `{}`), matching the
 * icons Halo uses for the same thing elsewhere.
 */
const FAMILY_ICONS: Partial<Record<WorkKind, LucideIcon>> = {
  image: FileImage,
  browser: Globe,
  terminal: TerminalSquare,
  'web-search': Globe,
  collaborator: UserPlus,
  message: Send,
  team: Users,
  skill: Puzzle,
}

const STEP_KINDS: Partial<Record<Thought['type'], string>> = {
  thinking: 'Reasoning',
  system: 'System',
  error: 'Error',
  tool_result: 'Result',
}

/** Tools whose target is a command, path or pattern, set in monospace. */
const LITERAL_TARGETS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])

export interface OperationLabel {
  /** An i18n key when `translate`, otherwise the tool's own name. */
  kind: string
  translate: boolean
  target: string
  monospace: boolean
}

/** `mcp__server__tool_name` → `tool_name`. */
function shortToolName(name: string): string {
  const parts = name.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : name
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function firstLine(value: string): string {
  const trimmed = value.trim()
  const end = trimmed.indexOf('\n')
  return end < 0 ? trimmed : trimmed.slice(0, end)
}

function urlTarget(value: unknown): string {
  const url = text(value)
  try {
    const parsed = new URL(url)
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

function toolTarget(name: string, input: Record<string, unknown> | undefined, baseDir: string | undefined): string {
  if (!input) return ''
  const path = (value: unknown) => (text(value) ? displayPath(text(value), baseDir) : '')
  switch (name) {
    case 'Bash': return text(input.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': return path(input.file_path)
    case 'NotebookEdit': return path(input.notebook_path)
    case 'Glob': return [text(input.pattern), path(input.path)].filter(Boolean).join(' · ')
    case 'Grep': return [text(input.pattern), path(input.path)].filter(Boolean).join(' · ')
    case 'WebFetch': return urlTarget(input.url)
    case 'WebSearch': return text(input.query)
    case 'Task':
    case 'Agent': return text(input.description) || firstLine(text(input.prompt))
    case 'Skill': return text(input.skill) || text(input.name)
    case 'AskUserQuestion': {
      const questions = input.questions
      return Array.isArray(questions) ? text((questions[0] as { question?: unknown } | undefined)?.question) : ''
    }
    case 'ToolSearch': return text(input.query)
    default: return getToolFriendlyFormat(name, input)
  }
}

/** What a family tool acted on: its action when the family has several, then its first argument. */
function familyTarget(family: WorkKind, name: string, input: Record<string, unknown> | undefined): string {
  const tool = shortToolName(name)
  const subject = text(input?.url) ? urlTarget(input?.url)
    : text(input?.to) || text(input?.target) || text(input?.name) || getToolFriendlyFormat(name, input)
  const action = family === 'browser' ? tool.replace(/^browser_/, '')
    : family === 'terminal' ? tool.replace(/^terminal_/, '')
    : family === 'team' ? tool.replace(/^team_/, '')
    : ''
  return [action, firstLine(subject)].filter(Boolean).join(' · ')
}

export function describeOperation(step: Thought, baseDir?: string): OperationLabel {
  if (step.type === 'tool_use') {
    const name = step.toolName ?? ''
    const work = workKind(step)
    if (work === 'image') return { kind: 'Image', translate: true, target: toolTarget(name, step.toolInput, baseDir), monospace: true }
    const family = work ? FAMILY_KINDS[work] : undefined
    if (family) return { kind: family, translate: true, target: familyTarget(work!, name, step.toolInput), monospace: false }
    const kind = TOOL_KINDS[name]
    return {
      kind: kind ?? shortToolName(name),
      translate: !!kind,
      target: toolTarget(name, step.toolInput, baseDir),
      monospace: LITERAL_TARGETS.has(name),
    }
  }
  // Reasoning and notices are prose: the line shows their opening words, not just a first line like "Done so far:".
  const content = step.type === 'tool_result' ? step.toolOutput ?? step.content : step.content
  return { kind: STEP_KINDS[step.type] ?? 'System', translate: true, target: content.trim(), monospace: false }
}

/**
 * Lines a file edit added and removed, counted the way the reply's file
 * changes are, so the two agree. Undefined for anything that is not an edit.
 */
export function editStats(step: Thought): { added: number; removed: number } | undefined {
  if (step.type !== 'tool_use' || !step.toolInput) return undefined
  const input = step.toolInput
  if (step.toolName === 'Write' && typeof input.content === 'string') {
    return { added: input.content.split('\n').length, removed: 0 }
  }
  if (step.toolName === 'Edit' && (typeof input.old_string === 'string' || typeof input.new_string === 'string')) {
    return calculateDiffStats(text(input.old_string), text(input.new_string))
  }
  return undefined
}

/** A step's icon: its tool family's when it has one, else the shared icon for its tool or type. */
export function operationIcon(step: Thought): LucideIcon {
  const family = workKind(step)
  return (family && FAMILY_ICONS[family]) || getThoughtIcon(step.type, step.toolName)
}
