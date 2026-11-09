import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CostTracker } from '../../core/cost.js';
import type { ToolContext } from '../../types/tool.js';
import { getLogger } from '../../utils/logger.js';
import { ReadTool } from './index.js';

let tmpDir: string;
let filePath: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-pdf-'));
  filePath = path.join(tmpDir, 'document.pdf');
  await fs.writeFile(filePath, '%PDF-1.7\nDocument contents must not be presented as read.\n');
  ctx = {
    sessionId: 'pdf-test',
    cwd: tmpDir,
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
    readFileState: new Map(),
  };
  vi.spyOn(getLogger('Tool:Read'), 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('PDF capability feedback', () => {
  it('explains how to obtain contents without claiming to have read the document', async () => {
    const result = await new ReadTool().execute({ file_path: filePath }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain(filePath);
    expect(result.content).toContain('No PDF text or images were extracted');
    expect(result.content).toContain('Changing pages on Read will not extract contents');
    expect(result.content).toContain('PDF-capable tool');
    expect(result.content).toContain('OCR');
    expect(result.content).not.toContain('Document contents must not be presented as read');
    expect(ctx.readFileState?.size).toBe(0);
    expect(getLogger('Tool:Read').warn).not.toHaveBeenCalled();
  });

  it.each([
    ['7', '7'],
    ['3-22', '3-22'],
    [' 03 - 22 ', '3-22'],
    [String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER)],
  ])('accepts selection %s without claiming those pages exist', async (pages, selection) => {
    const result = await new ReadTool().execute({ file_path: filePath, pages }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain(`Requested pages: ${selection}`);
    expect(result.content).toContain("The document's page count has not been checked");
    expect(result.content).toContain('No PDF text or images were extracted');
    expect(ctx.readFileState?.size).toBe(0);
  });

  it('gives bounded continuation guidance for a 21-page selection', async () => {
    const result = await new ReadTool().execute({ file_path: filePath, pages: '7-27' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Requested 21 pages');
    expect(result.content).toContain('selection limit is 20');
    expect(result.content).toContain('"7-26"');
    expect(result.content).toContain('continue from page 27');
    expect(result.content).toContain('Changing pages on Read will not extract contents');
    expect(ctx.readFileState?.size).toBe(0);
    expect(getLogger('Tool:Read').warn).toHaveBeenCalledOnce();
    expect(getLogger('Tool:Read').warn).toHaveBeenCalledWith('PDF request failed', {
      sessionId: 'pdf-test', filePath, error: expect.any(Error),
    });
  });

  it.each([
    '', '0', '-1', '1.5', '4-2', '1,3', '1-',
    '9007199254740992', '1-9007199254740992', '9'.repeat(400),
    3, null, {}, [],
  ])('rejects malformed or inexact page selection %# with corrective guidance', async (pages) => {
    const result = await new ReadTool().execute({ file_path: filePath, pages }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid PDF page selection');
    expect(result.content).toContain('"2" or "2-4"');
    expect(result.content).not.toContain('TypeError');
    expect(ctx.readFileState?.size).toBe(0);
    expect(getLogger('Tool:Read').warn).toHaveBeenCalledOnce();
  });

  it.each([
    [100 * 1024 * 1024, false],
    [100 * 1024 * 1024 + 1, true],
  ])('checks the file-size boundary at %i bytes without reading its contents', async (size, isError) => {
    await fs.truncate(filePath, size);
    const result = await new ReadTool().execute({ file_path: filePath }, ctx);

    expect(result.isError).toBe(isError);
    expect(result.content).toContain(`${size} bytes`);
    expect(result.content).toContain('No PDF text or images were extracted');
    expect((await fs.stat(filePath)).size).toBe(size);
    expect(ctx.readFileState?.size).toBe(0);
  });
});
