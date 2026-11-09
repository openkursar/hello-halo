/**
 * @module tools/edit
 * EditTool — exact string replacement in files.
 * @license MIT
 */

import * as path from 'node:path';
import type { Tool, ToolContext, ToolResult, PermissionLevel, FileReadState } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { name, description, inputSchema } from './schema.js';
import { tryFormatFile } from './format.js';
import { isFileStateFresh, setFileReadState } from '../file-read-state.js';
import { getLogger } from '../../utils/logger.js';
import {
  assertFileSize, FILE_CHANGED_MESSAGE, hashFileContent, readFileSnapshot, withFileLock, writeFileSnapshot,
} from '../file-access.js';

export class EditTool implements Tool {
  readonly name = name;
  readonly description = description;
  readonly inputSchema: Record<string, unknown> = inputSchema;
  readonly permissionLevel: PermissionLevel = 'write';

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string | undefined;
    const oldString = input.old_string as string | undefined;
    const newString = input.new_string as string | undefined;
    const replaceAll = (input.replace_all as boolean) ?? false;

    if (!filePath) {
      return toolError('file_path is required');
    }
    if (oldString === undefined || oldString === null || oldString.length === 0) {
      return toolError('old_string is required');
    }
    if (newString === undefined || newString === null) {
      return toolError('new_string is required');
    }

    // Validate old != new
    if (oldString === newString) {
      return toolError('Edit rejected identical old_string and new_string values. Supply different replacement text, or omit this edit if no change is needed.');
    }

    const resolvedPath = path.resolve(ctx.cwd, filePath);
    const state = ctx.readFileState?.get(resolvedPath);
    return withFileLock(resolvedPath, () => this.editFile(resolvedPath, oldString, newString, replaceAll, ctx, state));
  }

  private async editFile(
    resolvedPath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    ctx: ToolContext,
    state: FileReadState | undefined,
  ): Promise<ToolResult> {
    if (ctx.readFileState && !state) {
      return toolError('Edit needs a recorded Read of this file. Read the target, then prepare old_string from the returned source text and retry.');
    }
    let snapshot;
    try {
      snapshot = await readFileSnapshot(resolvedPath);
    } catch (e) {
      getLogger('Tool:Edit').warn('file snapshot failed', { filePath: resolvedPath, error: e });
      return toolError(`Failed to read file ${resolvedPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const content = snapshot.bytes.toString('utf-8');
    if (ctx.readFileState) {
      if (!state) return toolError('Edit needs a recorded Read of this file. Read the target, then prepare old_string from the returned source text and retry.');
      if (!isFileStateFresh(state, hashFileContent(snapshot.bytes), snapshot.stat.mtimeMs, true)) {
        getLogger('Tool:Edit').warn('stale file edit refused', { filePath: resolvedPath });
        return toolError(FILE_CHANGED_MESSAGE);
      }
    }

    // Count occurrences
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(oldString, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + oldString.length;
    }

    if (count === 0) {
      return toolError(
        `Edit found no literal match for old_string. Read the target again and copy the intended passage with its original spaces, tabs, and line breaks; exclude displayed line numbers. No replacement was made.\nUnmatched old_string: ${oldString}`,
      );
    }

    if (count > 1 && !replaceAll) {
      return toolError(
        `The edit is ambiguous: old_string occurs ${count} times. Include enough adjacent source text to select one occurrence, or set replace_all=true if every occurrence should change.\nold_string: ${oldString}`,
      );
    }

    const replacements = replaceAll ? count : 1;
    const resultBytes = Buffer.byteLength(content, 'utf8') + replacements *
      (Buffer.byteLength(newString, 'utf8') - Buffer.byteLength(oldString, 'utf8'));
    try { assertFileSize(resultBytes); } catch (error) {
      getLogger('Tool:Edit').warn('oversized edit refused', { filePath: resolvedPath, bytes: resultBytes });
      return toolError((error as Error).message);
    }

    // Perform replacement
    let newContent: string;
    if (replaceAll) {
      newContent = content.split(oldString).join(newString);
    } else {
      // Replace only first occurrence
      const idx = content.indexOf(oldString);
      newContent = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
    }

    const bytes = Buffer.from(newContent, 'utf-8');
    try {
      await writeFileSnapshot(resolvedPath, bytes, snapshot);
    } catch (e) {
      ctx.readFileState?.delete(resolvedPath);
      getLogger('Tool:Edit').warn('file edit failed', { filePath: resolvedPath, error: e });
      return toolError(`Failed to write file ${resolvedPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    ctx.recordFileChange?.(resolvedPath, snapshot.bytes, bytes);
    await tryFormatFile(resolvedPath);

    let formatterChanged = false;
    let refreshFailed = false;
    if (ctx.readFileState) {
      try {
        const finalSnapshot = await readFileSnapshot(resolvedPath);
        formatterChanged = !finalSnapshot.bytes.equals(bytes);
        if (formatterChanged) {
          ctx.readFileState.delete(resolvedPath);
          getLogger('Tool:Edit').warn('file changed after edit; read authorization revoked', { filePath: resolvedPath });
        } else {
          setFileReadState(ctx.readFileState, resolvedPath, {
            content: state?.isPartialView ? undefined : newContent,
            contentHash: hashFileContent(bytes),
            timestamp: finalSnapshot.stat.mtimeMs,
            isPartialView: state?.isPartialView,
          });
        }
      } catch (e) {
        ctx.readFileState.delete(resolvedPath);
        refreshFailed = true;
        getLogger('Tool:Edit').warn('post-edit read state invalidated', { filePath: resolvedPath, error: e });
      }
    }

    let message = `Successfully edited ${resolvedPath} (${replacements} replacement${replacements !== 1 ? 's' : ''}).`;
    if (formatterChanged) {
      message +=
        ' Note: the file changed again after this edit. Re-read it before further changes.';
    }
    if (refreshFailed) {
      message += ' The read state could not be refreshed. Read the file again before further changes.';
    }
    return toolSuccess(message, {
      file_path: resolvedPath,
      replacements,
    });
  }
}
