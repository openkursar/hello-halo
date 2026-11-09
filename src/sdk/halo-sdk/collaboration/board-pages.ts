import { randomUUID } from 'node:crypto';

const SECTIONS = ['members', 'tasks', 'findings', 'activities'] as const;
type Section = typeof SECTIONS[number];
export type BoardSnapshot = Record<Section, readonly object[]>;
const PREFIX = 'collaboration-board:';
const PAGE_BYTES = 24 * 1024;
const PREVIEW_SECTION_BYTES = 6 * 1024;

interface Archive {
  id: string;
  key: string;
  snapshot: BoardSnapshot;
  preview: string;
}

/** Readable archive pages keep large boards out of the model context without losing records. */
export class BoardPages {
  private readonly archives: Archive[] = [];

  preview(key: string, snapshot: () => BoardSnapshot): string {
    const existing = this.archives.find(archive => archive.key === key);
    if (existing) return existing.preview;
    const full = snapshot();
    let truncated = false;
    const preview: Partial<Record<Section, object[]>> = {};
    const counts = Object.fromEntries(SECTIONS.map(section => [section, full[section].length]));
    for (const section of SECTIONS) {
      const selected: object[] = [];
      let bytes = 0;
      for (let index = full[section].length - 1; index >= 0 && selected.length < 100; index--) {
        const row = full[section][index];
        const size = Buffer.byteLength(JSON.stringify(row));
        if (bytes + size > PREVIEW_SECTION_BYTES) break;
        selected.unshift(row);
        bytes += size + 1;
      }
      preview[section] = selected;
      truncated ||= selected.length !== full[section].length;
    }
    const id = randomUUID();
    const result = JSON.stringify({ ...preview, counts, truncated,
      ...(truncated ? { archive: `${PREFIX}${id}:0:0`, instructions: 'Read the archive with team_read_artifact before treating omitted records as absent. Each page supplies the next reference.' } : {}) });
    this.archives.push({ id, key, snapshot: full, preview: result });
    if (this.archives.length > 2) this.archives.shift();
    return result;
  }

  clear(): void { this.archives.length = 0; }

  read(ref: string): string | undefined {
    if (!ref.startsWith(PREFIX)) return undefined;
    const match = /^collaboration-board:([a-f0-9-]+):(\d+):(\d+)$/.exec(ref);
    if (!match) throw new Error('Invalid board archive reference. Read the current board for a fresh reference.');
    const archive = this.archives.find(item => item.id === match[1]);
    if (!archive) throw new Error('This board archive expired after newer board reads. Read the board again for a current archive.');
    let row = Number(match[2]);
    let offset = Number(match[3]);
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(offset)) throw new Error('Invalid board archive position.');
    const count = SECTIONS.reduce((sum, section) => sum + archive.snapshot[section].length, 0);
    if (row >= count) throw new Error('The board archive position is outside this snapshot.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (row < count && bytes < PAGE_BYTES) {
      let index = row;
      let section: Section = 'members';
      for (const candidate of SECTIONS) {
        section = candidate;
        if (index < archive.snapshot[candidate].length) break;
        index -= archive.snapshot[candidate].length;
      }
      const record = Buffer.from(JSON.stringify({ section, record: archive.snapshot[section][index] }) + '\n');
      if (offset >= record.length || (offset > 0 && (record[offset] & 0xc0) === 0x80)) throw new Error('Invalid board archive byte offset.');
      let end = Math.min(record.length, offset + PAGE_BYTES - bytes);
      while (end < record.length && end > offset && (record[end] & 0xc0) === 0x80) end--;
      if (end === offset) break;
      chunks.push(record.subarray(offset, end));
      bytes += end - offset;
      if (end === record.length) { row++; offset = 0; }
      else { offset = end; break; }
    }
    const next = row < count ? `${PREFIX}${archive.id}:${row}:${offset}` : null;
    return JSON.stringify({ format: 'jsonl-fragment', next }) + '\n' + Buffer.concat(chunks).toString('utf8');
  }
}
