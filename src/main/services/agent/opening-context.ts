/**
 * The memory that opens a conversation's first turn rides ahead of the user's
 * message. The engine routes a slash command only while it opens the message, so
 * the memory steps aside for one; the session instructions still name its file.
 */

// A bare `/tmp` or `/Users` at the start of a message is a path being talked about, not a command.
const ROOT_DIRECTORIES = new Set([
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
  'Applications', 'Library', 'System', 'Users', 'Volumes', 'private',
])

/**
 * Whether the text opens with a slash command such as `/name args` or
 * `/plugin:name`. A path such as `/etc/hosts` or `/tmp` does not.
 */
export function opensWithSlashCommand(text: string): boolean {
  const name = /^\s*\/([A-Za-z0-9][\w.:-]*)(?:\s|$)/.exec(text)?.[1]
  return name !== undefined && !ROOT_DIRECTORIES.has(name)
}
