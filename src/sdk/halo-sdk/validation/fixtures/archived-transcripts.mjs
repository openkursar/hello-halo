import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeArchivedFixture(path, sessionId, records) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map(record => JSON.stringify({
    uuid: randomUUID(), sessionId, isSidechain: true, timestamp: '2026-01-01T00:00:00.000Z', ...record,
  })).join('\n') + '\n', 'utf8');
}
