/**
 * The folders and files an agent engine reads as its own settings, hooks or
 * standing instructions, and how a file name is read when matching them.
 *
 * Pure string logic: no Node or Electron imports (shared-module constraint).
 */

/**
 * Folders an engine, or git that it runs, reads as settings, hooks, skills,
 * commands or standing instructions, wherever they sit in the workspace
 * (engines walk into subfolders for them). A strict turn's file tools may read
 * them but never write them: what is written there outlives the turn and acts
 * with the owner's authority — settings and hooks run commands, instructions
 * speak into every later session, a skill's files are reloaded while the turn
 * runs.
 *
 *   .claude   Claude Code: settings (hooks, permissions), skills, commands,
 *             agents, instructions; Halo SDK: skills, commands, instructions
 *   .agents   Halo SDK: skills, commands, instructions
 *   .codex    Codex: project configuration
 *   .git      git, which Claude Code runs in the workspace as every session
 *             starts: its config and hooks run commands. A `.git` file (a
 *             pointer to another git folder) is caught by the same name.
 */
export const ENGINE_CONTROL_FOLDERS: readonly string[] = ['.claude', '.agents', '.codex', '.git']

/**
 * Files an engine reads as its own, by name, in any folder.
 *
 *   CLAUDE.md, CLAUDE.local.md    Claude Code (and Halo SDK) instructions
 *   AGENTS.md, AGENTS.override.md Halo SDK and Codex instructions
 *   .mcp.json                     MCP servers a project declares
 */
export const ENGINE_CONTROL_FILES: readonly string[] = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', '.mcp.json']

// Compared without case: case-insensitive file systems are the common ones.
const ENGINE_FOLDERS = new Set(ENGINE_CONTROL_FOLDERS.map(name => name.toLowerCase()))
const ENGINE_FILES = new Set(ENGINE_CONTROL_FILES.map(name => name.toLowerCase()))

/**
 * A path segment as the file it names: Windows writes `CLAUDE.md::$DATA` and
 * `CLAUDE.md.` to `CLAUDE.md`, ignoring a stream suffix and trailing dots and
 * spaces. Read that way everywhere — refusing such a name elsewhere costs nothing.
 */
export function fileNameOf(segment: string): string {
  const colon = segment.indexOf(':')
  return (colon === -1 ? segment : segment.slice(0, colon)).replace(/[. ]+$/, '').toLowerCase()
}

/** Whether a path segment names one of {@link ENGINE_CONTROL_FILES}. */
export function isEngineControlFileName(segment: string): boolean {
  return ENGINE_FILES.has(fileNameOf(segment))
}

/** Whether a path segment names one of {@link ENGINE_CONTROL_FOLDERS}. */
export function isEngineControlFolderName(segment: string): boolean {
  return ENGINE_FOLDERS.has(fileNameOf(segment))
}
