/**
 * @module prompt/memory
 * Project instruction file loading — reads the instruction files named by
 * {@link AgentConventions.memoryFiles} from the project directory tree and
 * the user config directory.
 *
 * When `settingSources` includes `'project'` or `'local'`, the file system is
 * walked from `cwd` toward the home directory, collecting every instruction
 * file found in each directory and in the sub-directories listed by
 * {@link AgentConventions.memorySubdirs}. When `'user'` is included, the
 * user-level config directory is scanned too.
 *
 * The collected content is injected into the system prompt's `<memory>` block,
 * giving the model project-specific context (coding conventions, rules, etc.)
 * without requiring the caller to manage memory files explicitly.
 *
 * Only applied when using the preset system prompt mode (not a custom string
 * system prompt) — callers who supply a full system prompt string handle
 * memory injection themselves.
 * @license MIT
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_CONVENTIONS,
  resolveHome,
  type AgentConventions,
} from '../core/conventions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingSource = 'user' | 'project' | 'local';

/** Source descriptor for a loaded memory file. */
interface MemoryFile {
  filePath: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to read a file synchronously.
 * Returns the trimmed content or `undefined` if the file is missing or unreadable.
 */
function tryReadFile(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identity of a file for de-duplication, with symlinks resolved.
 *
 * Callers must key on this rather than on the probed path: a directory laid
 * out as `.claude -> .agents` (or individual files symlinked across the two
 * conventions) would otherwise be collected once per spelling and the same
 * instructions would reach the model twice.
 */
function fileIdentity(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Probe a directory for instruction files.
 * Returns all files found, in sub-directory × filename order.
 */
function probeDir(dir: string, conventions: AgentConventions): MemoryFile[] {
  const found: MemoryFile[] = [];
  for (const sub of conventions.memorySubdirs) {
    const base = sub ? path.join(dir, sub) : dir;
    for (const name of conventions.memoryFiles) {
      const filePath = path.join(base, name);
      const content = tryReadFile(filePath);
      if (content !== undefined) {
        found.push({ filePath, content });
      }
    }
  }
  return found;
}

/**
 * Walk up the directory tree from `start`, yielding each directory up to
 * (and including) `stopAt`. Stops at the filesystem root if `stopAt`
 * is not encountered.
 */
function* walkUp(start: string, stopAt: string): Generator<string> {
  let current = path.resolve(start);
  const stop = path.resolve(stopAt);
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);
    yield current;
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// LoadProjectMemoryOptions
// ---------------------------------------------------------------------------

export interface LoadProjectMemoryOptions {
  /**
   * When true, each memory file's content is prefixed with a path annotation
   * header:
   *
   * ```
   * Contents of /path/to/AGENTS.md (<source description>):
   *
   * [file content]
   * ```
   *
   * Default: false (raw content concatenation, no attribution).
   */
  includePaths?: boolean;
  /** Filesystem conventions to collect under. Defaults to {@link DEFAULT_CONVENTIONS}. */
  conventions?: AgentConventions;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Preamble text prepended before memory content when using path annotations.
 * Instructs the model that memory file instructions take priority over defaults.
 */
const MEMORY_INSTRUCTION_PROMPT =
  "These instruction files describe the user's preferences and this project's working rules. Apply relevant requirements when planning and carrying out the task; they take precedence over the agent's usual defaults.";

// ---------------------------------------------------------------------------
// Internal: path description helper
// ---------------------------------------------------------------------------

/**
 * Return a human-readable description for a memory file based on its
 * location relative to `cwd` and `home`.
 */
function describeSource(filePath: string, cwd: string, home: string): string {
  const abs = path.resolve(filePath);
  const absCwd = path.resolve(cwd);
  const absHome = path.resolve(home);

  // User-level: lives under the user config directory, not inside cwd
  const inHome = abs.startsWith(absHome + path.sep) || abs === absHome;
  const inCwd = abs.startsWith(absCwd + path.sep) || abs === absCwd;

  if (inHome && !inCwd) return 'user settings';
  if (inCwd) return 'instructions in the working project';
  return 'parent project instructions';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load project instruction files based on `settingSources`.
 *
 * Collection strategy:
 * - `'project'` / `'local'`: walk from `cwd` toward the home directory,
 *   reading the configured instruction file names from each directory and
 *   from each of its configured sub-directories.
 * - `'user'`: read the same names from `$HOME` and from the user config
 *   directory (the `configDirEnv` environment variable, falling back to
 *   `<home>/<userConfigDirName>`).
 *
 * Files are de-duplicated by resolved path, so a symlinked layout is read
 * once. The result is a concatenated string of all contents, or `undefined`
 * if nothing was found.
 *
 * When `options.includePaths` is true each file is prefixed with a path
 * annotation header so the model knows the origin of each instruction block.
 *
 * @param cwd - Working directory to start the project walk from.
 * @param env - Environment variables (used to resolve the config dir and HOME).
 * @param settingSources - Which sources to include.
 * @param options - Additional formatting and convention options.
 */
export function loadProjectMemory(
  cwd: string,
  env: Record<string, string | undefined>,
  settingSources: readonly SettingSource[],
  options?: LoadProjectMemoryOptions,
): string | undefined {
  const collected: MemoryFile[] = [];
  const seen = new Set<string>();
  const home = resolveHome(env);
  const conventions = options?.conventions ?? DEFAULT_CONVENTIONS;

  /** Collect a file unless the same underlying file was already collected. */
  const collect = (filePath: string, content: string): void => {
    const id = fileIdentity(filePath);
    if (seen.has(id)) return;
    seen.add(id);
    collected.push({ filePath, content });
  };

  // ── User-level files ────────────────────────────────────────────────────
  if (settingSources.includes('user')) {
    // Home-level config dir, e.g. ~/.claude/AGENTS.md
    const homeConfigDir = path.join(home, conventions.userConfigDirName);
    for (const { filePath, content } of probeDir(homeConfigDir, conventions)) {
      collect(filePath, content);
    }

    // An explicitly configured config dir is a separate source, not a
    // replacement — collect it too unless it resolves to the same place.
    const configuredDir = env[conventions.configDirEnv];
    if (configuredDir && path.resolve(configuredDir) !== path.resolve(homeConfigDir)) {
      for (const { filePath, content } of probeDir(configuredDir, conventions)) {
        collect(filePath, content);
      }
    }
  }

  // ── Project-level files (walk up from cwd) ──────────────────────────────
  if (settingSources.includes('project') || settingSources.includes('local')) {
    // Walk from cwd up toward home (inclusive on both ends).
    // Files in deeper directories are added first so child conventions
    // override parent conventions when displayed to the model.
    const projectFiles: MemoryFile[] = [];
    for (const dir of walkUp(cwd, home)) {
      for (const { filePath, content } of probeDir(dir, conventions)) {
        const id = fileIdentity(filePath);
        if (seen.has(id)) continue;
        seen.add(id);
        projectFiles.push({ filePath, content });
      }
    }
    // User-scope files already collected rank higher; project files follow
    // in cwd-first order.
    collected.push(...projectFiles);
  }

  if (collected.length === 0) return undefined;

  if (options?.includePaths) {
    // Prepend the instruction preamble, then annotate each file with its
    // path so the model can trace the origin of each instruction block.
    const annotatedFiles = collected
      .map((f) => {
        const source = describeSource(f.filePath, cwd, home);
        return `Contents of ${f.filePath} (${source}):\n\n${f.content}`;
      })
      .join('\n\n');
    return `${MEMORY_INSTRUCTION_PROMPT}\n\n${annotatedFiles}`;
  }

  // Default: concatenate raw content without attribution headers.
  // Matches the original behaviour used for system-prompt <memory> injection.
  return collected.map((f) => f.content).join('\n\n');
}
