/**
 * Filesystem conventions shared by instruction discovery and persistent state.
 * Earlier entries take precedence; Options.conventions overrides the defaults.
 * @license MIT
 */

import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** Where the engine looks for instructions, skills and per-user state. */
export interface AgentConventions {
  /** Instruction-file names probed per directory, highest precedence first. */
  memoryFiles: readonly string[];
  /**
   * Sub-directories probed inside each project directory for instruction
   * files. `''` means the directory itself.
   */
  memorySubdirs: readonly string[];
  /** Directories holding skills and slash commands, highest precedence first. */
  agentDirs: readonly string[];
  /** Environment variable holding the user-level config directory. */
  configDirEnv: string;
  /** User-level config directory name under `$HOME` when the env var is unset. */
  userConfigDirName: string;
}

export const DEFAULT_CONVENTIONS: AgentConventions = {
  memoryFiles: ['AGENTS.md', 'CLAUDE.md'],
  memorySubdirs: ['', '.agents', '.claude'],
  agentDirs: ['.agents', '.claude'],
  configDirEnv: 'CLAUDE_CONFIG_DIR',
  userConfigDirName: '.claude',
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Apply a partial override on top of the defaults.
 *
 * Overriding an array replaces it wholesale — a caller asking for its own
 * convention should not have to repeat the defaults to keep them out.
 */
export function resolveConventions(
  override?: Partial<AgentConventions>,
): AgentConventions {
  return override ? { ...DEFAULT_CONVENTIONS, ...override } : DEFAULT_CONVENTIONS;
}

/** Home directory, preferring the session's env over the process env. */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.HOME ?? env.USERPROFILE ?? process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

/**
 * Resolve the user-level config directory: the configured env var when set,
 * otherwise `<home>/<userConfigDirName>`.
 *
 * Single source for a path that storage, skills and instructions all key off,
 * so pointing the engine at a different directory moves all of them together.
 */
export function userConfigDir(
  env: Record<string, string | undefined> = process.env,
  conventions: AgentConventions = DEFAULT_CONVENTIONS,
): string {
  const configured = Object.prototype.hasOwnProperty.call(env, conventions.configDirEnv)
    ? env[conventions.configDirEnv]
    : process.env[conventions.configDirEnv];
  return configured ?? path.join(resolveHome(env), conventions.userConfigDirName);
}
