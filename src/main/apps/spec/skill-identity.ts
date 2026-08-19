/**
 * apps/spec -- Skill Command Name Derivation
 *
 * A skill's `name` is an ecosystem identifier, not a display string: it becomes
 * the on-disk directory, the SKILL.md frontmatter `name`, and therefore the
 * slash command the SDK exposes. Claude's skill format expects that to be
 * ASCII, so a name written in another script must be romanized before it can
 * serve as one — the authored form is preserved in `display_name`.
 *
 * Deliberately separate from `store/publish/spec-enrich`'s `deriveSlug`, which
 * mirrors the registry server's Go implementation and is allowed to return an
 * empty string. A command name never can: every skill must end up with a
 * usable directory.
 */

import { pinyin } from 'pinyin-pro'

/** CJK Unified Ideographs + common extension ranges. */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
const CJK_RUN_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g

/** Characters outside printable ASCII are what the directory sanitizer
 * destroys, so they are exactly the trigger for derivation. Names that are
 * merely un-slug-like ("Code Review") already round-trip and are left alone. */
const NON_ASCII_RE = /[^\x20-\x7e]/

/** Each CJK character romanizes to a whole syllable, so a short title can
 * expand past any reasonable directory name without a cap. */
const MAX_LENGTH = 48

/** Whether `name` cannot serve as a skill directory / slash command as written. */
export function needsCommandNameDerivation(name: string): boolean {
  return NON_ASCII_RE.test(name)
}

/**
 * Convert an authored skill name into an ASCII command name.
 * Always returns a non-empty, directory-safe slug.
 */
export function deriveSkillCommandName(name: string): string {
  let input = name
  if (CJK_RE.test(input)) {
    input = input.replace(
      CJK_RUN_RE,
      (run) => ` ${pinyin(run, { toneType: 'none', type: 'array' }).join(' ')} `,
    )
  }

  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return capLength(slug) || `skill-${fingerprint(name)}`
}

/** Truncate at a hyphen boundary so the result stays readable. */
function capLength(slug: string): string {
  if (slug.length <= MAX_LENGTH) return slug
  const cut = slug.slice(0, MAX_LENGTH)
  const lastHyphen = cut.lastIndexOf('-')
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '')
}

/**
 * FNV-1a digest, used only when romanization yields nothing (Cyrillic, kana,
 * emoji-only names). Gives such skills a stable, collision-resistant directory
 * instead of failing the install.
 */
function fingerprint(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
