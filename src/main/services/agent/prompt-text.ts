/**
 * Agent Module - Text Placed Inside Halo's Prompt Blocks
 *
 * File names, terminal titles, conversation titles and the like reach the
 * model inside `<halo_references>` and `<halo_task>`. None of them is
 * necessarily the user's own words — a cloned repository names its files, a
 * program sets its terminal's title, an AI titles a conversation — so a line
 * break or a tag in one of them must not be able to end its line or its block
 * and have the rest read as the user speaking.
 */

import { truncateChars } from '../../../shared/content-reference'

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const CONTROL_RUNS = /[\u0000-\u001f\u007f]+/g

/** Breaks a tag that would open or close one of Halo's blocks; the text stays readable. */
export function neutralizeBlockTags(text: string): string {
  return text.replace(/<(\/?)(halo_)/gi, '<$1\\$2')
}

/** A one-line field: control characters folded to spaces, block tags broken, bounded without splitting a character. */
export function inlineText(value: string, maxChars = 500): string {
  const line = neutralizeBlockTags(value.replace(CONTROL_RUNS, ' '))
  return line.length > maxChars ? `${truncateChars(line, maxChars - 1)}…` : line
}

/**
 * A path as one line. A name with control characters in it (legal on POSIX)
 * is written as a JSON string, so it stays exact instead of being folded.
 */
export function inlinePath(path: string): string {
  return neutralizeBlockTags(CONTROL_CHARS.test(path) ? JSON.stringify(path) : path)
}

/** Markdown inline code around a one-line text, its delimiter longer than any backtick run inside. */
export function inlineCode(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(longest + 1)
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`
}
