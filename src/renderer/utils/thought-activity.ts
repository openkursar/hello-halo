/**
 * What an agent is doing right now, read from its steps: the one-line activity
 * the thought panel shows while a turn runs ("Reading config.json..."), and the
 * todo list its todo tool keeps. Shared so every surface that reports agent
 * progress (the chat's thought panel, a review card) says the same thing.
 *
 * Returns i18n keys and parameters, never translated text.
 */

import type { Thought } from '../types'

// i18n static keys for extraction (DO NOT REMOVE)
// prettier-ignore
void function _i18nActionKeys(t: (k: string) => string) {
  t('Generating {{tool}}...'); t('Reading {{file}}...'); t('Writing {{file}}...');
  t('Editing {{file}}...'); t('Searching {{pattern}}...'); t('Matching {{pattern}}...');
  t('Executing {{command}}...'); t('Fetching {{url}}...'); t('Searching {{query}}...');
  t('Updating tasks...'); t('Executing {{task}}...'); t('Waiting for user response...');
  t('Setting goal...'); t('Updating goal...'); t('Completing goal...'); t('Abandoning goal...');
  t('Processing...'); t('Thinking...');
}

export interface ThoughtActivity {
  /** An i18n key, e.g. 'Reading {{file}}...'. */
  key: string
  params?: Record<string, string>
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
  /** Present continuous label shown while in progress. */
  activeForm?: string
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.substring(0, maxLength - 1) + '…'
}

// "/foo/bar/config.json" -> "config.json"
function fileName(path: unknown): string {
  if (typeof path !== 'string' || !path) return 'file'
  return truncate(path.split(/[/\\]/).pop() || path, 20)
}

// "npm install lodash --save" -> "npm install"
function commandSummary(cmd: unknown): string {
  if (typeof cmd !== 'string' || !cmd) return 'command'
  return truncate(cmd.split(' ').slice(0, 2).join(' '), 20)
}

function searchTerm(term: unknown): string {
  if (typeof term !== 'string' || !term) return '...'
  return truncate(term, 15)
}

function urlDomain(url: unknown): string {
  if (typeof url !== 'string' || !url) return 'page'
  try {
    return truncate(new URL(url).hostname.replace('www.', ''), 20)
  } catch {
    return truncate(url, 20)
  }
}

function goalActionKey(action: unknown): string {
  switch (action) {
    case 'update': return 'Updating goal...'
    case 'complete': return 'Completing goal...'
    case 'abandon': return 'Abandoning goal...'
    default: return 'Setting goal...'
  }
}

/**
 * The most recent main-agent action, searched from the end (sub-agent steps
 * are skipped). 'Thinking...' when the latest step is reasoning or nothing
 * has happened yet.
 */
export function describeThoughtActivity(thoughts: readonly Thought[]): ThoughtActivity {
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const th = thoughts[i]
    if (th.parentToolUseId) continue
    if (th.type === 'tool_use' && th.toolName) {
      if (th.isStreaming || !th.isReady) {
        return { key: 'Generating {{tool}}...', params: { tool: th.toolName } }
      }
      const input = th.toolInput
      switch (th.toolName) {
        case 'Read': return { key: 'Reading {{file}}...', params: { file: fileName(input?.file_path) } }
        case 'Write': return { key: 'Writing {{file}}...', params: { file: fileName(input?.file_path) } }
        case 'Edit': return { key: 'Editing {{file}}...', params: { file: fileName(input?.file_path) } }
        case 'Grep': return { key: 'Searching {{pattern}}...', params: { pattern: searchTerm(input?.pattern) } }
        case 'Glob': return { key: 'Matching {{pattern}}...', params: { pattern: searchTerm(input?.pattern) } }
        case 'Bash': return { key: 'Executing {{command}}...', params: { command: commandSummary(input?.command) } }
        case 'WebFetch': return { key: 'Fetching {{url}}...', params: { url: urlDomain(input?.url) } }
        case 'WebSearch': return { key: 'Searching {{query}}...', params: { query: searchTerm(input?.query) } }
        case 'TodoWrite': return { key: 'Updating tasks...' }
        case 'Task':
          if (input?.subagent_type === 'web-searcher') {
            return { key: 'Searching {{query}}...', params: { query: searchTerm(input?.prompt) } }
          }
          return { key: 'Executing {{task}}...', params: { task: searchTerm(input?.description) } }
        case 'NotebookEdit': return { key: 'Editing {{file}}...', params: { file: fileName(input?.notebook_path) } }
        case 'AskUserQuestion': return { key: 'Waiting for user response...' }
        case 'Goal': return { key: goalActionKey(input?.action) }
        default: return { key: 'Processing...' }
      }
    }
    if (th.type === 'thinking') return { key: 'Thinking...' }
  }
  return { key: 'Thinking...' }
}

/** The items of a TodoWrite call's input. */
export function parseTodoInput(input: Record<string, unknown>): TodoItem[] {
  const todos = input.todos as Array<{ content: string; status: string; activeForm?: string }> | undefined
  if (!todos || !Array.isArray(todos)) return []
  return todos.map(t => ({
    content: t.content || '',
    status: (t.status as TodoStatus) || 'pending',
    activeForm: t.activeForm,
  }))
}

/** The todo list as of the latest TodoWrite among `thoughts`; null when there is none. */
export function latestTodos(thoughts: readonly Thought[]): TodoItem[] | null {
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const th = thoughts[i]
    if (th.type === 'tool_use' && th.toolName === 'TodoWrite' && th.toolInput && !th.parentToolUseId) {
      return parseTodoInput(th.toolInput)
    }
  }
  return null
}
