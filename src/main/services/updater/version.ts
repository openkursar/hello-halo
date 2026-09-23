/**
 * Semantic-version precedence, per semver.org §11.
 *
 * Implemented here rather than taken from a package because this is the check
 * that decides whether the app replaces its own binaries. A comparator that is
 * subtly wrong either never updates or downgrades in a loop, so it is worth
 * owning outright and testing against the version strings this product
 * actually ships (`2.1.16-dev.0-rc.7` and friends).
 *
 * Build metadata (`+sha`) is ignored for precedence, as the spec requires.
 */

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers; empty means a stable release. */
  prerelease: string[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a version string, or null when it is not valid semver. */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim())
  if (!match) return null

  const prerelease = match[4] ? match[4].split('.') : []
  // A trailing or doubled dot yields an empty identifier, which has no defined
  // precedence — treat the whole string as unusable rather than guess.
  if (prerelease.some((id) => id.length === 0)) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

/** True when an identifier is all digits, which compares numerically. */
function isNumeric(id: string): boolean {
  return /^\d+$/.test(id)
}

/**
 * Compare prerelease identifier lists.
 *
 * Numeric identifiers rank below alphanumeric ones, numeric compare as
 * numbers, and a longer list outranks a shorter list that is otherwise equal —
 * which is what makes `rc.10` newer than `rc.9` and `2.1.0` newer than
 * `2.1.0-rc.1`.
 */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // A version with no prerelease identifiers is the released one, and outranks
  // every prerelease of the same major.minor.patch.
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const left = a[i]
    const right = b[i]
    if (left === right) continue

    const leftNumeric = isNumeric(left)
    const rightNumeric = isNumeric(right)
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }

  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * Compare two versions: negative when `a` precedes `b`, 0 when equal in
 * precedence, positive when `a` follows `b`.
 *
 * Throws on unparseable input. Callers deciding whether to install something
 * must not be handed a silent 0 for a string nobody could interpret.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left) throw new Error(`Unparseable version: ${JSON.stringify(a)}`)
  if (!right) throw new Error(`Unparseable version: ${JSON.stringify(b)}`)

  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * Whether `candidate` is a version worth moving to from `current`.
 *
 * Unparseable input answers "no": an update feed we cannot read is not grounds
 * for replacing the running application.
 */
export function isUpgrade(candidate: string, current: string): boolean {
  try {
    return compareVersions(candidate, current) > 0
  } catch (error) {
    console.error(`[Updater] Refusing update with unreadable version: ${String(error)}`)
    return false
  }
}
