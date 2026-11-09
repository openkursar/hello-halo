/**
 * @module tools/grep
 * GrepTool — content search powered by ripgrep (rg).
 * Runs an absolute host-configured binary, otherwise resolves rg on the session PATH.
 * @license MIT
 */

import { spawn } from '../../utils/processes.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolContext, ToolResult, PermissionLevel } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { name, description, inputSchema } from './schema.js';
import { extensionsForType } from './file-types.js';
import { ripgrepCommand, ripgrepEnvironment } from './environment.js';
import { getLogger } from '../../utils/logger.js';
import { DEFAULT_MAX_RESULT_SIZE_CHARS, truncateContent } from '../../utils/truncate.js';
import { deniedBelow, isDeniedReal, readDeniedMessage, realPath } from '../../utils/read-deny.js';

const DEFAULT_HEAD_LIMIT = 250;
// Aligned with the query-loop tool-result budget so truncation notices
// emitted here survive instead of being re-truncated downstream.
const MAX_OUTPUT_SIZE = DEFAULT_MAX_RESULT_SIZE_CHARS;
// Recovery the model can take itself; host setup belongs in the warning log.
const NO_SEARCH_FALLBACK = 'Use Glob to find files and Read to inspect them, or search with a shell command.';

export class GrepTool implements Tool {
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

    const searchPath = input.path
      ? path.isAbsolute(input.path as string)
        ? (input.path as string)
        : path.resolve(ctx.cwd, input.path as string)
      : ctx.cwd;

    const outputMode = (input.output_mode as string) || 'files_with_matches';
    const headLimit = (input.head_limit as number) ?? DEFAULT_HEAD_LIMIT;
    const offset = (input.offset as number) ?? 0;
    const caseInsensitive = (input['-i'] as boolean) ?? false;
    const showLineNumbers = (input['-n'] as boolean) ?? true;
    const multiline = (input.multiline as boolean) ?? false;
    const contextLines = input.context as number | undefined;
    const contextA = input['-A'] as number | undefined;
    const contextB = input['-B'] as number | undefined;
    const contextC = input['-C'] as number | undefined;
    const fileType = input.type as string | undefined;
    const globPattern = input.glob as string | undefined;

    // Build rg arguments
    const args: string[] = [];

    // Output mode
    switch (outputMode) {
      case 'files_with_matches':
        args.push('-l');
        break;
      case 'count':
        args.push('-c');
        break;
      case 'content':
        // Default rg behavior — show matching lines
        if (showLineNumbers) {
          args.push('-n');
        }
        break;
    }

    // Case insensitive
    if (caseInsensitive) {
      args.push('-i');
    }

    // Multiline
    if (multiline) {
      args.push('-U');
      args.push('--multiline-dotall');
    }

    // Context lines
    if (contextC !== undefined) {
      args.push('-C', String(contextC));
    } else if (contextLines !== undefined) {
      args.push('-C', String(contextLines));
    } else {
      if (contextA !== undefined) {
        args.push('-A', String(contextA));
      }
      if (contextB !== undefined) {
        args.push('-B', String(contextB));
      }
    }

    // File type filter
    if (fileType) {
      const exts = extensionsForType(fileType);
      for (const ext of exts) {
        args.push('--glob', `*.${ext}`);
      }
    }

    // Glob filter
    if (globPattern) {
      args.push('--glob', globPattern);
    }

    // Head limit: use rg's --max-count for files_with_matches/count,
    // but for content mode we handle it after collecting output.

    const scope = await denialScope(searchPath, ctx.readDenyRoots ?? []);
    if (scope.denied) {
      return toolError(readDeniedMessage(searchPath));
    }
    // Last, so no glob of the caller's can re-include what they close.
    args.push(...scope.excludeGlobs);

    // Pattern and path
    args.push('--', pattern, scope.rgPath ?? searchPath);

    const env = ripgrepEnvironment(ctx.env);
    const command = ripgrepCommand(env);
    try {
      const { stdout: output, killedEarly } = await runRg(command, args, env, ctx.abortSignal, scope.rgCwd);

      if (output.trim().length === 0) {
        return toolSuccess(
          `No matches found for pattern "${pattern}" in ${searchPath}. Check the pattern syntax (ripgrep regex), broaden the pattern, or search a different path.`,
        );
      }

      // Split into lines, dropping the trailing empty line from rg's final \n
      // so totals reported below are honest.
      let lines = output.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines = lines.slice(0, -1);
      }
      const totalLines = lines.length;

      // Apply offset and head_limit
      let sliced = lines;
      if (offset > 0) {
        sliced = sliced.slice(offset);
      }
      if (headLimit > 0) {
        sliced = sliced.slice(0, headLimit);
      }
      const shown = sliced.length;

      let result = sliced.join('\n');

      // Pagination footer whenever the model is seeing a window, not the whole.
      // killedEarly means rg was stopped before finishing — the total is a lower bound.
      const totalStr = `${killedEarly ? 'at least ' : ''}${totalLines}`;
      if (offset > 0 || shown < totalLines || killedEarly) {
        result += `\n\n[Showing lines ${offset + 1}-${offset + shown} of ${totalStr} matching lines. Use offset=${offset + shown} to continue, or narrow the search with a more specific pattern, glob, type, or path.]`;
      }

      // Truncate if too large
      if (result.length > MAX_OUTPUT_SIZE) {
        result = truncateContent(result, MAX_OUTPUT_SIZE,
          'Narrow the pattern or path, or use head_limit and offset to request a smaller page.');
      }

      return toolSuccess(result);
    } catch (error) {
      const failure = error instanceof RipgrepProcessError ? error : undefined;
      const errMsg = error instanceof Error ? error.message : String(error);
      getLogger('Grep').warn('Content search failed', {
        sessionId: ctx.sessionId,
        executable: command === 'rg' ? 'PATH' : 'configured',
        reason: failure?.kind ?? 'unexpected',
        code: failure?.code,
        exitCode: failure?.exitCode,
        signal: failure?.signal,
      });
      if (failure?.kind === 'spawn' && command !== 'rg') {
        return toolError(
          `The configured ripgrep executable could not be started (${failure.code ?? 'spawn error'}): ${errMsg}. ` +
            NO_SEARCH_FALLBACK,
        );
      }
      if (failure?.kind === 'spawn' && failure.code === 'ENOENT') {
        return toolError(
          'Content search is unavailable: ripgrep (rg) could not be started from the session PATH. ' +
            NO_SEARCH_FALLBACK,
        );
      }
      return toolError(`Grep failed: ${errMsg}`);
    }
  }
}

interface DenialScope {
  /** The search path itself is denied */
  denied: boolean;
  /** rg `--glob` arguments that keep it out of denied paths below the search */
  excludeGlobs: string[];
  /** Search path and working folder for rg when excludes apply */
  rgPath?: string;
  rgCwd?: string;
}

/**
 * How a search stays out of denied paths: refused when it starts inside one,
 * otherwise walked with every denied path below it excluded, so rg never opens
 * them.
 *
 * rg matches an exclude glob against the path relative to its working folder,
 * resolved through links. The search therefore runs from the real path of its
 * root, spelled the same way, with each exclude anchored there; results then
 * print under that real path.
 */
async function denialScope(searchPath: string, roots: readonly string[]): Promise<DenialScope> {
  if (roots.length === 0) return { denied: false, excludeGlobs: [] };
  const real = realPath(searchPath);
  if (isDeniedReal(real, roots)) return { denied: true, excludeGlobs: [] };

  let isDir = false;
  try {
    isDir = (await fs.stat(real)).isDirectory();
  } catch {
    // Missing path: rg reports it as it always has.
  }
  const below = isDir ? deniedBelow(real, roots) : [];
  if (below.length === 0) return { denied: false, excludeGlobs: [] };
  return {
    denied: false,
    excludeGlobs: below.flatMap((rel) => ['--glob', `!/${escapeGlob(rel)}`]),
    rgPath: real,
    rgCwd: real,
  };
}

/** A literal path as an rg glob: each glob metacharacter matched as itself. */
function escapeGlob(literal: string): string {
  return literal.replace(/[*?[\]{}\\]/g, (ch) =>
    ch === '\\' ? '\\\\' : `[${ch}]`,
  );
}

class RipgrepProcessError extends Error {
  constructor(
    readonly kind: 'spawn' | 'exit' | 'aborted',
    message: string,
    readonly code?: string,
    readonly exitCode?: number | null,
    readonly signal?: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = 'RipgrepProcessError';
  }
}

/**
 * Run ripgrep as a child process and collect output.
 * killedEarly is true when rg was stopped before finishing because output
 * exceeded the collection cap — line totals derived from stdout are then
 * a lower bound, not an exact count.
 */
function runRg(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  abortSignal?: AbortSignal,
  cwd?: string,
): Promise<{ stdout: string; killedEarly: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let killedEarly = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Early termination if output is too large
      if (stdout.length > MAX_OUTPUT_SIZE * 2) {
        killedEarly = true;
        proc.kill('SIGTERM');
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new RipgrepProcessError('spawn', err.message, (err as NodeJS.ErrnoException).code));
    });

    proc.on('close', (code, signal) => {
      if (code === 0 || code === 1 || killedEarly) {
        // code 1 = no matches, which is fine; a SIGTERM kill after the cap
        // still yields usable (partial) output.
        resolve({ stdout, killedEarly });
      } else {
        reject(new RipgrepProcessError('exit', `rg exit code ${code}${signal ? ` (${signal})` : ''}: ${stderr}`, undefined, code, signal));
      }
    });

    // Handle abort
    if (abortSignal) {
      const onAbort = () => {
        proc.kill('SIGTERM');
        reject(new RipgrepProcessError('aborted', 'Grep aborted'));
      };
      if (abortSignal.aborted) {
        proc.kill('SIGTERM');
        reject(new RipgrepProcessError('aborted', 'Grep aborted'));
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
      proc.on('close', () => {
        abortSignal.removeEventListener('abort', onAbort);
      });
    }
  });
}
