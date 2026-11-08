/**
 * Skill Trigger Command
 *
 * A skill's slash-command is derived client-side from its spec name — it is
 * not a stored field. Shared so every surface that displays or prefills
 * "how to invoke this skill" computes the identical string.
 */
export function deriveSkillCommand(name: string): string {
  return `/${name.toLowerCase().replace(/\s+/g, '-')}`
}

export function prefillSkillCommand(draft: string, text: string, commands: ReadonlyArray<{ command: string }>): string {
  const command = text.trim()
  const prefix = draft.match(/^(\s*)(\/[^\s/\\]+)(?=\s|$)/)
  if (!/^\/[^\s/\\]+$/.test(command) || !prefix) return `${text}${draft}`
  if (prefix[2] === command) return draft
  if (!commands.some(item => item.command === prefix[2])) return `${text}${draft}`
  return `${prefix[1]}${command}${draft.slice(prefix[0].length)}`
}

/** The composer text after choosing `command` from the slash menu: the command at the start replaces the typed one, and what follows it stays. */
export function completeSlashCommand(draft: string, command: string): string {
  const typed = draft.match(/^(\s*)\/\S*/)
  if (!typed) return `${command} `
  const rest = draft.slice(typed[0].length)
  return `${typed[1]}${command}${rest || ' '}`
}
