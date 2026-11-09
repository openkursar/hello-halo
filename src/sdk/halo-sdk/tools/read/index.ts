/**
 * @module tools/read
 * ReadTool — reads files from the local filesystem.
 * @license MIT
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolContext, ToolResult, PermissionLevel } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { name, description, inputSchema } from './schema.js';
import { readPdf } from './pdf.js';
import { formatNotebook } from './notebook.js';
import { readImage } from './image.js';
import { setFileReadState } from '../file-read-state.js';
import { hashFileContent, readFileSnapshot, withFileLock } from '../file-access.js';
import { isReadDenied, readDeniedMessage } from '../../utils/read-deny.js';
import { getLogger } from '../../utils/logger.js';
import { countLines } from '../../utils/text-lines.js';
import { copyString } from '../../utils/truncate.js';

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico',
]);

/**
 * Character budget for the formatted output. The query loop's tool-result
 * truncation digs a hole in the middle of oversized text, which would destroy
 * the cat -n line format and offset pagination — so Read narrows by whole
 * lines here instead and never hits that path.
 */
const MAX_OUTPUT_CHARS = 40_000;

export class ReadTool implements Tool {
  readonly name = name;
  readonly description = description;
  readonly inputSchema: Record<string, unknown> = inputSchema;
  readonly permissionLevel: PermissionLevel = 'readonly';
  readonly isConcurrencySafe = (): boolean => true;


  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string | undefined;
    if (!filePath) {
      return toolError('file_path is required');
    }

    for (const key of ['offset', 'limit']) {
      const value = input[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < (key === 'offset' ? 0 : 1))) {
        getLogger('Tool:Read').warn('invalid read pagination refused', { sessionId: ctx.sessionId, field: key });
        return toolError(`${key} must be a ${key === 'offset' ? 'nonnegative' : 'positive'} integer`);
      }
    }
    const resolvedPath = path.resolve(ctx.cwd, filePath);
    return withFileLock(resolvedPath, () => this.readFile(resolvedPath, input, ctx));
  }

  private async readFile(resolvedPath: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.readDenyRoots && isReadDenied(resolvedPath, ctx.readDenyRoots)) {
      return toolError(readDeniedMessage(resolvedPath));
    }

    // Check existence
    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch {
      return toolError(`File not found: ${resolvedPath}`);
    }

    // Reject directories
    if (stat.isDirectory()) {
      return toolError(
        `${resolvedPath} is a directory, not a file. Use Bash with \`ls\` to list directory contents.`,
      );
    }

    // Detect file type by extension
    const ext = path.extname(resolvedPath).toLowerCase().slice(1);

    // Image files
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const { text, image } = await readImage(resolvedPath);
        return toolSuccess(text, undefined, image ? [image] : undefined);
      } catch (e) {
        getLogger('Tool:Read').warn('image read failed', { filePath: resolvedPath, error: e });
        return toolError(e instanceof Error ? e.message : String(e));
      }
    }

    // PDF files
    if (ext === 'pdf') {
      try {
        const pages = input.pages as string | undefined;
        const result = await readPdf(resolvedPath, pages);
        return toolSuccess(result);
      } catch (e) {
        getLogger('Tool:Read').warn('PDF request failed', { sessionId: ctx.sessionId, filePath: resolvedPath, error: e });
        return toolError(e instanceof Error ? e.message : String(e));
      }
    }

    let snapshot;
    try {
      snapshot = await readFileSnapshot(resolvedPath);
    } catch (e) {
      getLogger('Tool:Read').warn('file snapshot failed', { filePath: resolvedPath, error: e });
      return toolError(`Failed to read file ${resolvedPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const content = snapshot.bytes.toString('utf-8');
    const contentHash = ctx.readFileState ? hashFileContent(snapshot.bytes) : undefined;
    const timestamp = snapshot.stat.mtimeMs;

    if (ext === 'ipynb') {
      try {
        const result = formatNotebook(content);
        setFileReadState(ctx.readFileState, resolvedPath, {
          content: result,
          contentHash,
          timestamp,
          // The rendered cells omit raw JSON metadata.
          isPartialView: true,
        });
        return toolSuccess(result);
      } catch (e) {
        return toolError(`Failed to parse notebook: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Empty file — still record readFileState so the model can Write to it
    // afterwards without tripping read-before-write.
    if (content.length === 0) {
      setFileReadState(ctx.readFileState, resolvedPath, {
        content: '',
        contentHash,
        timestamp,
        offset: input.offset as number | undefined,
        limit: input.limit as number | undefined,
      });
      return toolSuccess('<system-reminder>This file is empty; there are no lines to display.</system-reminder>');
    }

    const totalLines = countLines(content);

    const offsetInput = input.offset as number | undefined;
    const limitInput = input.limit as number | undefined;
    const offset = offsetInput ?? 0;
    const limit = limitInput ?? 2000;

    // Convert 1-based offset to 0-based index
    const start = offset > 0 ? offset - 1 : 0;
    let end = Math.min(start + limit, totalLines);

    if (start >= totalLines) {
      return toolSuccess(
        `<system-reminder>Requested line ${offset} is beyond this file's ${totalLines} lines. Choose an offset within that range.</system-reminder>`,
      );
    }

    const width = String(end).length;
    let output = '';
    let fitted = start;
    let truncatedLine = false;
    let cursor = 0;
    for (let index = 0; index < start; index++) cursor = content.indexOf('\n', cursor) + 1;
    const sliceStart = cursor;
    let sliceEnd = cursor;
    for (let i = start; i < end; i++) {
      const lineNum = String(i + 1).padStart(width, ' ');
      const newline = content.indexOf('\n', cursor);
      const lineEnd = newline < 0 ? content.length : newline;
      const nextLine = `${lineNum}\t${content.slice(cursor, lineEnd)}\n`;
      if (output.length + nextLine.length > MAX_OUTPUT_CHARS) {
        if (fitted === start) {
          output = nextLine.slice(0, MAX_OUTPUT_CHARS) + '\n';
          fitted = i + 1;
          truncatedLine = true;
        }
        break;
      }
      output += nextLine;
      fitted = i + 1;
      sliceEnd = lineEnd;
      cursor = lineEnd + 1;
    }
    end = fitted;
    if (truncatedLine) {
      output += `\n... (line ${start + 1} was truncated because it exceeds the character budget.)\n`;
    }

    if (end < totalLines) {
      output += `\n... (showing lines ${start + 1}-${end} of ${totalLines}. Use offset=${end + 1} to continue reading.)\n`;
    }

    const sliceContent = truncatedLine ? undefined : content.slice(sliceStart, sliceEnd);
    const isPartialView = truncatedLine || end < totalLines || start > 0;
    setFileReadState(ctx.readFileState, resolvedPath, {
      content: isPartialView ? sliceContent : content,
      contentHash,
      timestamp,
      offset: offsetInput,
      limit: limitInput,
      isPartialView: isPartialView ? true : undefined,
    });

    return toolSuccess(copyString(output));
  }
}
