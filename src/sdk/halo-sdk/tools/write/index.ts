/**
 * @module tools/write
 * WriteTool — writes files to the local filesystem.
 * @license MIT
 */

import * as path from 'node:path';
import { stat as statFile } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult, PermissionLevel, FileReadState } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { getLogger } from '../../utils/logger.js';
import { countLines } from '../../utils/text-lines.js';
import { name, description, inputSchema } from './schema.js';
import { isFileStateFresh, setFileReadState } from '../file-read-state.js';
import {
  assertFileSize, FILE_CHANGED_MESSAGE, hashFileContent, readFileSnapshot, withFileLock, writeFileSnapshot,
  type FileSnapshot,
} from '../file-access.js';

export class WriteTool implements Tool {
  readonly name = name;
  readonly description = description;
  readonly inputSchema: Record<string, unknown> = inputSchema;
  readonly permissionLevel: PermissionLevel = 'write';

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string | undefined;
    const content = input.content as string | undefined;

    if (!filePath) return toolError('file_path is required');
    if (content === undefined || content === null) return toolError('content is required');

    try { assertFileSize(Buffer.byteLength(content, 'utf8')); } catch (error) {
      getLogger('Tool:Write').warn('oversized write refused', { bytes: Buffer.byteLength(content, 'utf8') });
      return toolError((error as Error).message);
    }
    const resolvedPath = path.resolve(ctx.cwd, filePath);
    const state = ctx.readFileState?.get(resolvedPath);
    return withFileLock(resolvedPath, () => this.writeFile(resolvedPath, content, ctx, state));
  }

  private async writeFile(
    resolvedPath: string,
    content: string,
    ctx: ToolContext,
    state: FileReadState | undefined,
  ): Promise<ToolResult> {
    if (ctx.readFileState && (!state || state.isPartialView)) {
      try {
        await statFile(resolvedPath);
        return toolError('Write requires a complete Read of the existing file. Read its full contents before replacing it; use Edit for a targeted change based on a partial view.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLogger('Tool:Write').warn('file authorization check failed', { filePath: resolvedPath, error });
          return toolError(`Failed to stat ${resolvedPath}: ${String(error)}`);
        }
      }
    }
    let snapshot: FileSnapshot | undefined;
    try {
      snapshot = await readFileSnapshot(resolvedPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLogger('Tool:Write').warn('file snapshot failed', { filePath: resolvedPath, error: e });
        return toolError(`Failed to read file ${resolvedPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (ctx.readFileState) {
      if (snapshot && (!state || state.isPartialView)) {
        return toolError('Write requires a complete Read of the existing file. Read its full contents before replacing it; use Edit for a targeted change based on a partial view.');
      }
      if (state && (!snapshot || !isFileStateFresh(state, hashFileContent(snapshot.bytes), snapshot.stat.mtimeMs, false))) {
        getLogger('Tool:Write').warn('stale file write refused', { filePath: resolvedPath });
        return toolError(FILE_CHANGED_MESSAGE);
      }
    }

    const bytes = Buffer.from(content, 'utf-8');
    let stat;
    try {
      stat = await writeFileSnapshot(resolvedPath, bytes, snapshot);
    } catch (e) {
      // A failed in-place write may have changed some bytes; require a new Read.
      ctx.readFileState?.delete(resolvedPath);
      getLogger('Tool:Write').warn('file write failed', { filePath: resolvedPath, error: e });
      return toolError(`Failed to write file ${resolvedPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    setFileReadState(ctx.readFileState, resolvedPath, {
      content,
      contentHash: ctx.readFileState ? hashFileContent(bytes) : undefined,
      timestamp: stat.mtimeMs,
    });
    ctx.recordFileChange?.(resolvedPath, snapshot?.bytes ?? Buffer.alloc(0), bytes);

    const lineCount = countLines(content);
    const action = snapshot ? 'Wrote' : 'Created';
    return toolSuccess(`${action} ${resolvedPath} (${lineCount} lines, ${bytes.length} bytes)`, {
      file_path: resolvedPath,
      is_new: !snapshot,
      lines: lineCount,
      bytes: bytes.length,
    });
  }
}
