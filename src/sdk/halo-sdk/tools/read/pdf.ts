/**
 * @module tools/read/pdf
 * PDF request validation and capability feedback. Does not read document contents.
 * @license MIT
 */

import * as fs from 'node:fs/promises';

const PDF_MAX_FILE_SIZE = 100 * 1024 * 1024;
const PDF_MAX_PAGES_PER_READ = 20;
const PDF_CONTENT_GUIDANCE =
  'No PDF text or images were extracted. Changing pages on Read will not extract contents. ' +
  'Use an available PDF-capable tool or a local text extractor; scanned pages need OCR.';

export async function readPdf(filePath: string, pages?: string): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size > PDF_MAX_FILE_SIZE) {
    throw new Error(
      `PDF size is ${stat.size} bytes; Read accepts up to ${PDF_MAX_FILE_SIZE} bytes (100 MiB). ` +
      PDF_CONTENT_GUIDANCE,
    );
  }

  let selection = '';
  if (pages !== undefined) {
    const parsed = typeof pages === 'string' ? parsePdfPageRange(pages) : null;
    if (!parsed) {
      throw new Error(
        'Invalid PDF page selection: pages must be a string containing a positive safe integer ' +
        'or an ascending inclusive range, such as "2" or "2-4". ' +
        PDF_CONTENT_GUIDANCE,
      );
    }
    const rangeSize = parsed.end - parsed.start + 1;
    if (rangeSize > PDF_MAX_PAGES_PER_READ) {
      const firstEnd = parsed.start + PDF_MAX_PAGES_PER_READ - 1;
      throw new Error(
        `Requested ${rangeSize} pages; the selection limit is ${PDF_MAX_PAGES_PER_READ}. ` +
        `Split the selection into ranges of at most ${PDF_MAX_PAGES_PER_READ} pages: ` +
        `start with "${parsed.start}-${firstEnd}", then continue from page ${firstEnd + 1}. ` +
        PDF_CONTENT_GUIDANCE,
      );
    }
    selection = parsed.start === parsed.end ? `${parsed.start}` : `${parsed.start}-${parsed.end}`;
  }

  return (
    `PDF file: ${filePath} (${stat.size} bytes).\n` +
    (selection ? `Requested pages: ${selection}. The document's page count has not been checked.\n` : '') +
    PDF_CONTENT_GUIDANCE
  );
}

function parsePdfPageRange(pages: string): { start: number; end: number } | null {
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(pages.trim());
  if (!match) return null;

  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}
