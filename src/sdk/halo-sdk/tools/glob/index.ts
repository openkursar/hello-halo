/**
 * @module tools/glob
 * GlobTool — fast file pattern matching.
 * @license MIT
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Minimatch } from 'minimatch';
import type { Tool, ToolContext, ToolResult, PermissionLevel } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { name, description, inputSchema } from './schema.js';
import { isDeniedReal, readDeniedMessage, realPath } from '../../utils/read-deny.js';

const MAX_RESULTS = 250;

export class GlobTool implements Tool {
  readonly name = name;
  readonly description = description;
  readonly inputSchema: Record<string, unknown> = inputSchema;
  readonly permissionLevel: PermissionLevel = 'readonly';
  readonly isConcurrencySafe = (): boolean => true;


  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern as string | undefined;
    if (!pattern) {
      return toolError('pattern is required');
    }

    const baseDir = input.path
      ? path.isAbsolute(input.path as string)
        ? (input.path as string)
        : path.resolve(ctx.cwd, input.path as string)
      : ctx.cwd;

    // Validate directory exists
    try {
      const stat = await fs.stat(baseDir);
      if (!stat.isDirectory()) {
        return toolError(`Not a directory: ${baseDir}`);
      }
    } catch {
      return toolError(`Directory not found: ${baseDir}`);
    }

    // Denied paths are skipped while walking, so they never count toward the window.
    const denied = ctx.readDenyRoots ?? [];
    let realBase: string | null = null;
    if (denied.length > 0) {
      realBase = realPath(baseDir);
      if (isDeniedReal(realBase, denied)) return toolError(readDeniedMessage(baseDir));
    }

    // Walk directory recursively and match pattern
    const entries: Array<{ filePath: string; mtime: number }> = [];

    try {
      const matcher = new Minimatch(pattern, {
        dot: true,
        nocase: true,
        nonegate: true,
        nocomment: true,
        windowsPathsNoEscape: true,
      });
      await walkAndMatch(baseDir, matcher, baseDir, entries, realBase ? { realDir: realBase, denied } : null);
    } catch (e) {
      return toolError(
        `Glob failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (entries.length === 0) {
      return toolSuccess(
        `No files matched pattern "${pattern}" in ${baseDir}`,
      );
    }

    // Sort by modification time (most recent first)
    entries.sort((a, b) => b.mtime - a.mtime);

    const total = entries.length;
    const truncated = total > MAX_RESULTS;

    let output = '';
    for (let i = 0; i < Math.min(total, MAX_RESULTS); i++) {
      output += entries[i].filePath + '\n';
    }

    if (truncated) {
      output += `\n... and ${total - MAX_RESULTS} more files (showing first ${MAX_RESULTS} of ${total}, sorted by most recent modification). Narrow the pattern or search a subdirectory to see the rest.\n`;
    }

    return toolSuccess(output);
  }
}

/**
 * Recursively walk a directory and collect files matching a glob pattern.
 * The pattern is matched against the path relative to the initial `searchRoot`
 * (the user-named base directory), which stays fixed for the whole walk —
 * a per-directory base would reduce every match to its basename.
 *
 * `deny` carries the real path of `dir` alongside the one being printed, so a
 * denied entry is recognised without resolving links per entry (the walk does
 * not follow links, so the real path of a child is its parent's plus its name).
 */
async function walkAndMatch(
  dir: string,
  matcher: Minimatch,
  searchRoot: string,
  results: Array<{ filePath: string; mtime: number }>,
  deny: { realDir: string; denied: readonly string[] } | null = null,
): Promise<void> {
  // Skip large or system-level directories that are rarely useful for globbing.
  // NOTE: Hidden directories are NOT universally skipped here so that patterns
  // like ".agents/**" or ".claude/**" work correctly.  Only well-known heavy
  // directories (VCS internals, caches, build artefacts) are excluded.
  const SKIP_DIRS = new Set([
    'node_modules', '__pycache__',
    'target', 'dist', 'build', '.next', '.nuxt',
    // VCS
    '.git', '.hg', '.svn',
    // Package / build caches
    '.npm', '.yarn', '.cache', '.cargo', '.gradle',
  ]);

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const realChild = deny ? path.join(deny.realDir, entry.name) : null;
    if (deny && realChild && isDeniedReal(realChild, deny.denied)) continue;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walkAndMatch(fullPath, matcher, searchRoot, results, deny && realChild ? { realDir: realChild, denied: deny.denied } : null);
    } else if (entry.isFile()) {
      // Match against pattern
      const relativePath = path.relative(searchRoot, fullPath).split(path.sep).join('/');
      if (matcher.match(relativePath)) {
        try {
          const stat = await fs.stat(fullPath);
          results.push({ filePath: fullPath, mtime: stat.mtimeMs });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }
}
