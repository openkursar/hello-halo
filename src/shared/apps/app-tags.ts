/**
 * Tags a user puts on their installed apps (digital humans, skills, MCP
 * servers) to sort their own lists. A personal preference on the install
 * (`userOverrides.tags`): never part of the spec, the store or an export.
 *
 * Renderer-safe: no Electron/Node.
 */

export const MAX_TAG_LENGTH = 32
export const MAX_TAGS_PER_APP = 12

/** The lists that carry tags, by the app type each shows. */
export const TAGGABLE_APP_TYPES = ['automation', 'skill', 'mcp'] as const

export type TaggableAppType = (typeof TAGGABLE_APP_TYPES)[number]

/** Rename `from` to `to` on every item of one list, or remove it with `to` null. */
export interface RenameTagInput {
  type: TaggableAppType
  from: string
  to: string | null
}

/** A tag and how many items of one list carry it. */
export interface TagCount {
  name: string
  count: number
}

/**
 * The case-folded form tags are compared by. ASCII only, the same folding as
 * SQLite's lower(), so the database and every screen agree on which tags are
 * one tag.
 */
export function foldTag(value: string): string {
  return value.replace(/[A-Z]/g, letter => letter.toLowerCase())
}

/** Same tag, whatever the (ASCII) letter case. */
export function sameTag(a: string, b: string): boolean {
  return foldTag(a) === foldTag(b)
}

/** Trimmed, inner whitespace collapsed; empty when nothing usable is left. */
export function cleanTag(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** `cleanTag`, refusing a tag longer than the limit rather than cutting it. */
export function requireTag(value: string): string {
  const tag = cleanTag(value)
  if (!tag) throw new Error('A tag needs a name')
  if (tag.length > MAX_TAG_LENGTH) throw new Error(`A tag is at most ${MAX_TAG_LENGTH} characters`)
  return tag
}

/**
 * The stored form of a tag list: cleaned, empties dropped, duplicates (any
 * case) dropped keeping the first spelling. Throws when it holds too many.
 */
export function normalizeTags(values: unknown): string[] {
  if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) {
    throw new Error('tags must be a list of text labels')
  }
  const result: string[] = []
  for (const value of values as string[]) {
    if (!cleanTag(value)) continue
    const tag = requireTag(value)
    if (!result.some(existing => sameTag(existing, tag))) result.push(tag)
  }
  if (result.length > MAX_TAGS_PER_APP) throw new Error(`An item can carry at most ${MAX_TAGS_PER_APP} tags`)
  return result
}

/** `tags` with `from` renamed to `to` (merging into an existing `to`), or removed when `to` is null. */
export function renameInTags(tags: readonly string[], from: string, to: string | null): string[] {
  if (!tags.some(tag => sameTag(tag, from))) return [...tags]
  return normalizeTags(tags.flatMap(tag => (sameTag(tag, from) ? (to ? [to] : []) : [tag])))
}

/** Tags of `items`, most used first, then by name. */
export function countTags(items: Iterable<readonly string[] | undefined>): TagCount[] {
  const counts = new Map<string, TagCount>()
  for (const tags of items) {
    for (const tag of tags ?? []) {
      const key = foldTag(tag)
      const entry = counts.get(key)
      if (entry) entry.count++
      else counts.set(key, { name: tag, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Whether an item carries `tag` (any case); an empty filter matches everything. */
export function hasTag(tags: readonly string[] | undefined, tag: string | undefined): boolean {
  if (!tag) return true
  return (tags ?? []).some(existing => sameTag(existing, tag))
}

/** Whether a search text hits one of the tags. */
export function tagsMatchSearch(tags: readonly string[] | undefined, query: string): boolean {
  const q = foldTag(query.trim())
  if (!q) return true
  return (tags ?? []).some(tag => foldTag(tag).includes(q))
}
