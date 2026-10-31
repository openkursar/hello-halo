/**
 * Context that opens a conversation's first turn (the space or digital-human
 * memory) rides ahead of the user's message. The engine routes a slash command
 * only while it opens the message, so that context steps aside for one.
 */

/**
 * Whether the text opens with a slash command such as `/name args` or
 * `/plugin:name`. A path like `/etc/hosts` does not.
 */
export function opensWithSlashCommand(text: string): boolean {
  return /^\s*\/[A-Za-z0-9][\w.:-]*(?:\s|$)/.test(text)
}

/** `opening` ahead of `message`, except where it would hide a leading slash command. */
export function withOpeningContext(opening: string, message: string): string {
  return opensWithSlashCommand(message) ? message : opening + message
}
