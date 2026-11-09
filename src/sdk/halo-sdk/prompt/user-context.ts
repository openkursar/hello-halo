/**
 * @module prompt/user-context
 * Dynamic context builders.
 *
 * Key design decisions:
 *
 * - `getUserContext()` is **memoized per cwd** using a
 *   simple module-level Map cache (no lodash dependency).
 * - **Date is NOT written into the system prompt**.  It is injected via a
 *   `<system-reminder>` user message at the start of every conversation so
 *   that the cacheable system-prompt block is never invalidated by clock ticks.
 * - **Instruction-file content** follows the same path: it arrives in the user
 *   context message with per-file path annotations, not in the system prompt.
 *
 * Public surface consumed by `core/query-loop.ts`:
 *   - `buildUserContextMessage(cwd, env?, settingSources?, conventions?)` → `Message | null`
 *
 * @license MIT
 */

import type { Message } from '../types/provider.js';
import { buildSystemReminderMessage } from '../utils/system-reminder.js';
import { loadProjectMemory } from './memory.js';
import type { SettingSource } from './memory.js';
import type { AgentConventions } from '../core/conventions.js';


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape returned by getUserContext(). */
export interface UserContext {
  /** Combined instruction-file content with per-file path annotations. */
  memory?: string;
  /** ISO date string in the form "Today's date is YYYY-MM-DD." */
  currentDate: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return today's local ISO date string (YYYY-MM-DD).
 * Uses local time components instead of UTC to avoid off-by-one date errors
 * near midnight.
 */
function getLocalISODate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}


// ---------------------------------------------------------------------------
// Module-level memoization caches (keyed by cwd)
// ---------------------------------------------------------------------------

const userContextCache = new Map<string, Promise<UserContext>>();

// ---------------------------------------------------------------------------
// getUserContext()
// ---------------------------------------------------------------------------

/**
 * Load user context for the given working directory.
 *
 * Memoized per `cwd` and calendar date — the entry naturally rolls over
 * at midnight so a long-lived process never reports a stale date
 * (or until the process restarts).
 *
 * @param cwd            - Absolute path to the project root.
 * @param env            - Environment variables (forwarded to loadProjectMemory).
 * @param settingSources - Which memory sources to load (default: all).
 * @param conventions    - Filesystem conventions (forwarded to loadProjectMemory).
 */
function getUserContext(
  cwd: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  settingSources: readonly SettingSource[] = ['user', 'project', 'local'],
  conventions?: AgentConventions,
): Promise<UserContext> {
  const key = `${cwd}|${getLocalISODate()}`;
  const cached = userContextCache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<UserContext> => {
    // Load the configured instruction files with per-file path annotation.
    const memory = loadProjectMemoryWithPaths(cwd, env, settingSources, conventions) ?? undefined;

    return {
      ...(memory ? { memory } : {}),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    };
  })();

  userContextCache.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/**
 * Build a `<system-reminder>` user Message containing the user context
 * (instruction files + current date).
 *
 * The message is prepended to the conversation messages array so that
 * the model sees project instructions and the date on every turn, while
 * the system prompt's cacheable block remains stable.
 *
 * Returns `null` when there is nothing to inject (no instruction file and the
 * date was already embedded elsewhere — though in practice this function
 * always produces at least the date line).
 *
 * @param cwd            - Absolute path to the project root.
 * @param env            - Environment variables forwarded to memory loading.
 * @param settingSources - Which memory sources to include.
 */
export async function buildUserContextMessage(
  cwd: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  settingSources: readonly SettingSource[] = ['user', 'project', 'local'],
  conventions?: AgentConventions,
): Promise<Message | null> {
  const ctx = await getUserContext(cwd, env, settingSources, conventions);

  const sections: string[] = [];

  if (ctx.memory) {
    sections.push(`# memory\n${ctx.memory}`);
  }

  sections.push(
    `# currentDate\n${ctx.currentDate}\n\nUse this background information when it affects the request. It does not call for a separate reply or acknowledgement.`,
  );

  return buildSystemReminderMessage(sections.join('\n'));
}

// ---------------------------------------------------------------------------
// Internal: loadProjectMemory with per-file path annotations
// ---------------------------------------------------------------------------

/**
 * Load instruction-file content and annotate each file with its
 * source path header.
 *
 * Example output:
 * ```
 * Contents of /project/AGENTS.md (instructions in the working project):
 *
 * [file content here]
 * ```
 *
 * Collection is delegated to `loadProjectMemory`; this function only adds
 * the per-file path annotations.
 */
function loadProjectMemoryWithPaths(
  cwd: string,
  env: Record<string, string | undefined>,
  settingSources: readonly SettingSource[],
  conventions?: AgentConventions,
): string | undefined {
  // Delegate to memory.ts for collection and path-annotated formatting.
  return loadProjectMemory(cwd, env, settingSources as SettingSource[], {
    includePaths: true,
    conventions,
  });
}

/**
 * Derive a human-readable description of a memory file's source based on its
 * location relative to the project and user home directory.
 *
 * @param filePath - Absolute path to the memory file.
 * @param cwd      - Current working directory (project root).
 * @param home     - User home directory.
 */
