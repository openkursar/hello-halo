import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readSkillMetadata } from '../../skills'
import { readReadySessionSkills } from '../skill-availability'
import { opensWithSlashCommand } from '../opening-context'
import type { CcOptions } from './options'

const FORK_REFUSAL = 'This skill requests native fork execution, which Halo does not run. Its owner must remove context: fork before using it here. Creating a collaborator does not change that requirement.'
const SESSION_COMMANDS = new Set(['help', 'clear', 'compact', 'cost', 'model', 'status', 'context', 'permissions', 'config', 'exit', 'quit', 'usage',
  'autocompact', 'color', 'effort', 'fast', 'heapdump', 'init', 'mcp', 'reload-skills', 'rename', 'recap', 'goal'])

/** Inspects advertised commands and selected skills; ordinary turns do no file reads. */
export function createNativeSkillPolicy(options: CcOptions) {
  const sessionCommands = new Set(SESSION_COMMANDS)
  const refusal = (name: unknown, requireKnown: boolean, catalog?: ReturnType<typeof readReadySessionSkills>): string | null => {
    if (typeof name !== 'string' || !name || /[\\/\u0000-\u001f]/.test(name)) return 'The skill name cannot be resolved safely.'
    const parts = name.split(':')
    if (parts.some(part => !part || part === '.' || part === '..')) return 'The skill name cannot be resolved safely.'
    const leaf = parts.at(-1)!
    const paths = new Set((catalog ?? readReadySessionSkills(options) ?? []).filter(skill => skill.name === name).map(skill => skill.source.path))
    const roots: string[] = []
    const sources: string[] = options.settingSources ?? ['user', 'project']
    if (sources.includes('user')) roots.push(options.env?.CLAUDE_CONFIG_DIR ?? join(options.env?.HOME ?? options.env?.USERPROFILE ?? homedir(), '.claude'))
    if (sources.includes('project') && options.cwd) roots.push(join(options.cwd, '.claude'))
    for (const directory of options.additionalDirectories ?? []) roots.push(join(directory, '.claude'))
    for (const plugin of options.plugins ?? []) if (plugin.type === 'local') roots.push(plugin.path)
    for (const root of roots) {
      paths.add(join(root, 'skills', leaf, 'SKILL.md'))
      paths.add(join(root, 'skills', `${leaf}.md`))
      paths.add(join(root, 'commands', `${leaf}.md`))
      paths.add(join(root, 'commands', ...parts.slice(0, -1), `${leaf}.md`))
    }
    let found = false
    for (const path of paths) {
      try {
        const metadata = readSkillMetadata(path)
        found = true
        if (metadata.error) return 'The skill header cannot be verified. Repair its metadata before running it.'
        if (metadata.executionContext === 'fork') return FORK_REFUSAL
      } catch {
        if (existsSync(path)) return 'The skill source could not be inspected. Restore access before using it.'
      }
    }
    return !found && requireKnown ? 'This skill has no inspectable source in the session. Install an inline skill in Halo before using it.' : null
  }
  const commandRefusal = (name: string | undefined, requireKnown: boolean, catalog?: ReturnType<typeof readReadySessionSkills>): string | null => name === 'agents'
    ? 'Native agent management is unavailable. Use Halo team management.'
    : refusal(name, requireKnown && !sessionCommands.has(name ?? ''), catalog)
  return {
    filterCommands<T extends string | { name?: string; aliases?: string[] }>(commands: T[]): T[] {
      const catalog = commands.length ? readReadySessionSkills(options) ?? [] : []
      const reasons = new Map<string | undefined, string | null>()
      const hidden = new Map<string, number>()
      const allowed = (name: string | undefined): boolean => {
        if (!reasons.has(name)) reasons.set(name, commandRefusal(name, true, catalog))
        const reason = reasons.get(name)
        if (!reason) return true
        hidden.set(reason, (hidden.get(reason) ?? 0) + 1)
        return false
      }
      const filtered = commands.filter(command => allowed(typeof command === 'string' ? command : command.name))
        .map(command => typeof command === 'string' || !command.aliases ? command
          : Object.assign({}, command, { aliases: command.aliases.filter(allowed) }))
      if (hidden.size) console.warn('[CC] Command catalog filtered by host execution policy:', Object.fromEntries(hidden))
      return filtered
    },
    setCommands(commands: Array<{ name?: string; aliases?: string[] }> | undefined): void {
      for (const command of commands ?? []) {
        if (command.name && SESSION_COMMANDS.has(command.name)) {
          for (const alias of command.aliases ?? []) sessionCommands.add(alias)
        }
      }
    },
    hook: { matcher: 'Skill', hooks: [async (input: { tool_input?: { skill?: unknown } }) => {
      const reason = refusal(input.tool_input?.skill, true)
      if (!reason) return {}
      console.warn('[CC] Skill invocation refused by host execution policy:', reason)
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    }] },
    checkInput(message: any): void {
      const content = typeof message === 'string' ? message : message?.message?.content ?? message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find(block => block?.type === 'text')?.text : undefined
      const command = typeof text === 'string' ? /^\s*\/([^\s/]+)(?:\s|$)/.exec(text)?.[1] : undefined
      if (!command) return
      const reason = commandRefusal(command, opensWithSlashCommand(text))
      if (reason) {
        console.warn('[CC] Direct skill command refused by host execution policy:', reason)
        throw new Error(reason)
      }
    },
  }
}
