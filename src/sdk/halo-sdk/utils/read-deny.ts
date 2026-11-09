/**
 * @module utils/read-deny
 * Read-deny rules: the `Read(<path>)` entries of `disallowedTools`, in the
 * `Read(<path>)` permission-rule syntax, resolved to the paths they close.
 *
 * Read, Glob and Grep honour them. A denied path is
 * refused when named, and a search that would recurse into one skips it while
 * walking — so a denied file never takes a place in a result window, and
 * nothing about a result (its size, its paging note, its truncation) can
 * depend on what the denied files contain.
 *
 * Rule paths name one file or folder and everything below it:
 *   `//abs/path`   absolute (`//c/Users/...` on Windows)
 *   `~/path`       below the home folder
 *   anything else  relative to the session's working directory
 * A trailing `/**` means the same as the folder itself. Other wildcards are
 * not interpreted: such a rule is skipped with a warning rather than guessed
 * at, since widening it could close the whole workspace.
 * @license MIT
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { getLogger } from './logger.js';

const log = getLogger('ReadDeny');

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

const RULE = /^Read\((.+)\)$/;

/**
 * The paths the `Read(...)` rules of a tool blacklist close: absolute, links
 * resolved, spelled as found on disk. Entries that are not Read rules are
 * ignored.
 */
export function resolveReadDenyRoots(rules: readonly string[] | undefined, cwd: string): string[] {
  if (!rules || rules.length === 0) return [];
  const roots = new Set<string>();
  for (const rule of rules) {
    const match = RULE.exec(rule.trim());
    if (!match) continue;
    const target = ruleTarget(match[1].trim(), cwd);
    if (target) roots.add(realPath(target));
    else log.warn('read-deny rule with a wildcard is not supported; skipped', { rule });
  }
  return [...roots];
}

/** What a tool says when the path it was aimed at is denied. */
export function readDeniedMessage(absPath: string): string {
  return `Permission to read ${absPath} has been denied.`;
}

/** Whether `absPath` is a denied root or below one. */
export function isReadDenied(absPath: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;
  return isDeniedReal(realPath(absPath), roots);
}

/**
 * The same test for a path whose links are already resolved — the cheap form
 * for a walker that tracks the real path of every folder it enters.
 */
export function isDeniedReal(realAbsPath: string, roots: readonly string[]): boolean {
  const target = fold(realAbsPath);
  return roots.some((root) => within(target, fold(root)));
}

/**
 * Denied roots strictly below `realDir` (a real path), as paths relative to
 * it with `/` separators and the spelling found on disk.
 */
export function deniedBelow(realDir: string, roots: readonly string[]): string[] {
  const base = fold(realDir);
  const out: string[] = [];
  for (const root of roots) {
    const folded = fold(root);
    if (folded !== base && within(folded, base)) {
      out.push(path.relative(realDir, root).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * A path with its links resolved. A path that does not exist yet resolves
 * through its nearest existing ancestor, so a link higher up still counts.
 */
export function realPath(p: string): string {
  let head = path.resolve(p);
  let tail = '';
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) break;
      tail = tail ? path.join(path.basename(head), tail) : path.basename(head);
      head = parent;
    }
  }
  return tail ? path.join(head, tail) : head;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The absolute path a rule names; null when it holds a wildcard. */
function ruleTarget(spec: string, cwd: string): string | null {
  let p = spec.replace(/\/\*\*$/, '');
  if (/[*?[\]{}]/.test(p)) return null;
  if (p.startsWith('//')) {
    p = p.slice(1);
    const drive = /^\/([A-Za-z])(?:\/|$)/.exec(p);
    if (process.platform === 'win32' && drive) p = `${drive[1]}:\\${p.slice(3)}`;
    return path.resolve(p);
  }
  if (p === '~' || p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

function fold(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
