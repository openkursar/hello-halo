/**
 * package-paths.ts
 *
 * How an imported package's file paths are read: which entries carry no
 * content, where the package root actually is, and how a named entry is found
 * there.
 *
 * Every importer — skill parsing, digital-human parsing, type detection — must
 * resolve the root identically. When they each kept their own copy they drifted,
 * and a package classified by one rule then failed the parser that used another.
 */

/**
 * Entries that carry no package content: a zip's directory records, and the
 * metadata macOS adds when compressing (`__MACOSX/`, `.DS_Store`, AppleDouble
 * `._` twins).
 */
export function isIgnoredPackagePath(path: string): boolean {
  return (
    path.endsWith('/') ||
    path.startsWith('__MACOSX/') ||
    path.split('/').some(seg => seg === '.DS_Store' || seg.startsWith('._'))
  )
}

/**
 * The prefix of the lone folder wrapping the package, or `''` when the package
 * is already flat. Compressing a folder — the Finder default — nests everything
 * one level down, so both layouts have to be accepted.
 *
 * Callers pass paths that are already free of ignored entries; a stray
 * `__MACOSX/` would otherwise read as a second top-level folder and suppress
 * the unwrap.
 */
export function wrapperPrefix(paths: readonly string[]): string {
  const topSegments = new Set(paths.map(path => path.split('/')[0]).filter(Boolean))
  if (topSegments.size !== 1) return ''
  const prefix = `${[...topSegments][0]}/`
  // A root file whose name equals the folder's leaves the package half-nested;
  // treat it as flat rather than dropping the file.
  return paths.every(path => path.startsWith(prefix)) ? prefix : ''
}

/**
 * The path spelling `name`, or `undefined`. Case is not part of an entry's
 * identity: on a case-insensitive filesystem an author can save `skill.md` and
 * never notice, and that package then goes undiscovered on Linux. Importers
 * accept the variant and re-key it to the canonical spelling rather than reject
 * a package that is merely misspelled.
 *
 * An exact match wins, so an archive built on a case-sensitive filesystem
 * cannot have its real entry shadowed by a stray variant.
 */
export function findPackageEntry(paths: Iterable<string>, name: string): string | undefined {
  const lowered = name.toLowerCase()
  let variant: string | undefined
  for (const path of paths) {
    if (path === name) return path
    if (!variant && path.toLowerCase() === lowered) variant = path
  }
  return variant
}

/**
 * Re-key a package so `name` is spelled exactly that way, and drop any other
 * casing of it. The write-side twin of `findPackageEntry`: what is accepted on
 * the way in has to be straightened out before it is stored, because the
 * consumers downstream compare the name exactly.
 *
 * Variants are removed rather than carried: on a case-insensitive filesystem
 * they resolve to the same file as the canonical entry, so whichever is written
 * last wins — silently replacing normalized content with the raw variant.
 */
export function canonicalizePackageEntry(
  files: Record<string, string>,
  name: string,
): Record<string, string> {
  const lowered = name.toLowerCase()
  const matches = Object.keys(files).filter(path => path.toLowerCase() === lowered)
  if (matches.length === 0) return files
  if (matches.length === 1 && matches[0] === name) return files

  const entry = matches.includes(name) ? name : matches[0]
  const canonical: Record<string, string> = {}
  for (const [path, content] of Object.entries(files)) {
    if (!matches.includes(path)) canonical[path] = content
  }
  canonical[name] = files[entry]
  return canonical
}

/** Drop ignored entries and re-key what is left against the package root. */
export function unwrapPackageFolder(files: Record<string, string>): Record<string, string> {
  const kept = Object.entries(files).filter(([path]) => !isIgnoredPackagePath(path))
  const prefix = wrapperPrefix(kept.map(([path]) => path))

  const unwrapped: Record<string, string> = {}
  for (const [path, content] of kept) {
    const relative = path.slice(prefix.length)
    if (relative) unwrapped[relative] = content
  }
  return unwrapped
}
