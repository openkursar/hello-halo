/**
 * Unit tests for transcript read/write utilities.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getTranscriptPath,
  appendToTranscript,
  transcriptExists,
  TranscriptWriter,
  getLegacyRecordDirectory,
  getLegacyRecordPath,
  listLegacyRecordIds,
  readLegacyRecordMessages,
} from './transcript.js';
import type { Message } from '../types/provider.js';
import type { TranscriptOptions } from './transcript.js';
import { readHistory } from './transcript-reader.js';
import { writeArchivedFixture } from '../validation/fixtures/archived-transcripts.mjs';


async function seedArchive(sessionId: string, recordId: string, cwd: string, messages: Record<string, unknown>[], options?: TranscriptOptions): Promise<void> {
  await writeArchivedFixture(getLegacyRecordPath(sessionId, recordId, cwd, options), recordId, messages);
}

/** A stored session's history as resume reads it; null when nothing is stored. */
async function readStoredHistory(sessionId: string, cwd: string, stopAtMessageUuid?: string, options?: TranscriptOptions): Promise<Message[] | null> {
  try {
    return await readHistory(getTranscriptPath(sessionId, cwd, options), stopAtMessageUuid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CWD = '/test/project/dir';

let tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs = [];
  delete process.env.CLAUDE_CONFIG_DIR;
});

function withTempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-transcript-test-'));
  tempDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// getTranscriptPath
// ---------------------------------------------------------------------------

describe('transcript session environment', () => {
  it('isolates reads and writes using per-session environment and conventions', async () => {
    process.env.CLAUDE_CONFIG_DIR = withTempDir();
    const first = { env: { SDK_STATE: withTempDir() }, conventions: { configDirEnv: 'SDK_STATE', userConfigDirName: '.sdk' } };
    const second = { env: { SDK_STATE: withTempDir() }, conventions: first.conventions };
    const id = randomUUID();
    const writer = new TranscriptWriter(id, TEST_CWD, first);
    await writer.writeUserMessage({ role: 'user', content: 'isolated history' });
    expect(writer.path.startsWith(first.env.SDK_STATE)).toBe(true);
    expect(transcriptExists(id, TEST_CWD, second)).toBe(false);
    expect(await readStoredHistory(id, TEST_CWD, undefined, first)).toEqual([{ role: 'user', content: 'isolated history' }]);
    expect(await readStoredHistory(id, TEST_CWD, undefined, second)).toBeNull();
    await seedArchive(id, 'child', TEST_CWD, [{ type: 'assistant', message: { role: 'assistant', content: 'child result' } }], first);
    expect(await listLegacyRecordIds(id, TEST_CWD, first)).toEqual(['child']);
    expect(await listLegacyRecordIds(id, TEST_CWD, second)).toEqual([]);
    expect(await readLegacyRecordMessages(id, 'child', TEST_CWD, first)).toHaveLength(1);
  });

  it('inherits an unspecified process config directory but permits explicitly clearing it', () => {
    const configured = withTempDir();
    const home = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = configured;
    expect(getTranscriptPath('s', TEST_CWD, { env: {} }).startsWith(configured)).toBe(true);
    expect(getTranscriptPath('s', TEST_CWD, { env: { HOME: home, CLAUDE_CONFIG_DIR: undefined } }).startsWith(path.join(home, '.claude'))).toBe(true);
  });
});

describe('getTranscriptPath', () => {
  it('encodes non-alphanumeric chars in cwd as dashes', () => {
    const p = getTranscriptPath('sess-id', '/Users/dev/my-project');
    expect(p).toContain('-Users-dev-my-project');
    expect(p).toMatch(/sess-id\.jsonl$/);
  });

  it('produces path under projects/<projectDir>', () => {
    const p = getTranscriptPath('sess', '/cwd');
    expect(p).toContain(path.join('projects'));
    expect(p).toMatch(/\.jsonl$/);
  });
});

// ---------------------------------------------------------------------------
// appendToTranscript + resume read round-trip
// ---------------------------------------------------------------------------

describe('appendToTranscript / resume read', () => {
  it('round-trips user and assistant messages via TranscriptWriter', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();

    const writer = new TranscriptWriter(sessionId, TEST_CWD);
    await writer.writeUserMessage({ role: 'user', content: 'Hello' });
    await writer.writeAssistantMessage({ role: 'assistant', content: 'World' });

    const messages = await readStoredHistory(sessionId, TEST_CWD);
    expect(messages).not.toBeNull();
    expect(messages).toHaveLength(2);
    expect(messages![0].role).toBe('user');
    expect(messages![0].content).toBe('Hello');
    expect(messages![1].role).toBe('assistant');
    expect(messages![1].content).toBe('World');
  });

  it('returns null when transcript does not exist', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const result = await readStoredHistory(randomUUID(), TEST_CWD);
    expect(result).toBeNull();
  });

  it('stops reading at the entry matching stopAtMessageUuid (inclusive)', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();

    const writer = new TranscriptWriter(sessionId, TEST_CWD);
    await writer.writeUserMessage({ role: 'user', content: 'msg1' });
    const stopUuid = await writer.writeAssistantMessage({ role: 'assistant', content: 'msg2' });
    await writer.writeUserMessage({ role: 'user', content: 'msg3' });
    await writer.writeAssistantMessage({ role: 'assistant', content: 'msg4' });

    const messages = await readStoredHistory(sessionId, TEST_CWD, stopUuid);
    expect(messages).not.toBeNull();
    expect(messages).toHaveLength(2);
    expect(messages![0].content).toBe('msg1');
    expect(messages![1].content).toBe('msg2');
  });

  it('returns all messages when stopAtMessageUuid does not match any entry', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();

    const writer = new TranscriptWriter(sessionId, TEST_CWD);
    await writer.writeUserMessage({ role: 'user', content: 'a' });
    await writer.writeAssistantMessage({ role: 'assistant', content: 'b' });

    const messages = await readStoredHistory(sessionId, TEST_CWD, 'non-existent-uuid');
    expect(messages).toHaveLength(2);
  });

  it('skips malformed JSON lines gracefully', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const transcriptPath = getTranscriptPath(sessionId, TEST_CWD);

    await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
    const validEntry = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'valid' },
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      isSidechain: false,
    });
    await fs.promises.writeFile(transcriptPath, validEntry + '\n{malformed}\n', 'utf8');

    const messages = await readStoredHistory(sessionId, TEST_CWD);
    expect(messages).toHaveLength(1);
    expect(messages![0].content).toBe('valid');
  });

  it('appendToTranscript creates parent directories automatically', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const transcriptPath = getTranscriptPath(sessionId, TEST_CWD);

    // Directory should not exist yet
    expect(fs.existsSync(path.dirname(transcriptPath))).toBe(false);

    await appendToTranscript(transcriptPath, {
      type: 'user',
      message: { role: 'user', content: 'test' } as Message,
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      isSidechain: false,
      userType: 'external',
      cwd: TEST_CWD,
      version: '1.0.0',
    } as Parameters<typeof appendToTranscript>[1]);

    expect(fs.existsSync(transcriptPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// transcriptExists
// ---------------------------------------------------------------------------

describe('transcriptExists', () => {
  it('returns false when no transcript file', () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(transcriptExists(randomUUID(), TEST_CWD)).toBe(false);
  });

  it('returns true after transcript is written', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const transcriptPath = getTranscriptPath(sessionId, TEST_CWD);
    await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.promises.writeFile(transcriptPath, '{}', 'utf8');
    expect(transcriptExists(sessionId, TEST_CWD)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TranscriptWriter
// ---------------------------------------------------------------------------

describe('TranscriptWriter', () => {
  it('writes messages in order', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const writer = new TranscriptWriter(sessionId, TEST_CWD);

    await writer.writeUserMessage({ role: 'user', content: 'ping' });
    await writer.writeAssistantMessage({ role: 'assistant', content: 'pong' });

    const messages = await readStoredHistory(sessionId, TEST_CWD);
    expect(messages).toHaveLength(2);
    expect(messages![0].content).toBe('ping');
    expect(messages![1].content).toBe('pong');
  });

  it('exposes the transcript path', () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const writer = new TranscriptWriter(sessionId, TEST_CWD);
    expect(writer.path).toContain(sessionId);
    expect(writer.path).toMatch(/\.jsonl$/);
  });

  it('is a no-op when cwd is empty string', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const writer = new TranscriptWriter(sessionId, '');
    await writer.writeUserMessage({ role: 'user', content: 'test' });
    // No file should be created since enabled=false for empty cwd
    expect(transcriptExists(sessionId, '')).toBe(false);
  });

  it('writes metadata fields (userType, cwd, version) to each JSONL entry', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const writer = new TranscriptWriter(sessionId, TEST_CWD);

    await writer.writeUserMessage({ role: 'user', content: 'hello' });
    await writer.writeAssistantMessage({ role: 'assistant', content: 'world' });

    const transcriptPath = getTranscriptPath(sessionId, TEST_CWD);
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry.userType).toBe('external');
      expect(entry.cwd).toBe(TEST_CWD);
      expect(typeof entry.version).toBe('string');
      expect((entry.version as string).length).toBeGreaterThan(0);
      // gitBranch is optional — just verify it's string or absent
      if ('gitBranch' in entry) {
        expect(typeof entry.gitBranch).toBe('string');
      }
    }
  });

  it('preserves source order even when writes are fire-and-forget', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const writer = new TranscriptWriter(sessionId, TEST_CWD);

    // Submit 20 alternating writes without awaiting any of them.
    const submitted: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      submitted.push(
        role === 'user'
          ? writer.writeUserMessage({ role, content: `m${i}` })
          : writer.writeAssistantMessage({ role, content: `m${i}` }),
      );
    }
    await Promise.all(submitted);
    await writer.flush();

    const messages = await readStoredHistory(sessionId, TEST_CWD);
    expect(messages).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(messages![i].content).toBe(`m${i}`);
      expect(messages![i].role).toBe(i % 2 === 0 ? 'user' : 'assistant');
    }
  });

  it('flush() resolves only after all queued writes have hit disk', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const writer = new TranscriptWriter(sessionId, TEST_CWD);

    // Fire-and-forget 10 writes; do not await them individually.
    for (let i = 0; i < 10; i++) {
      void writer.writeUserMessage({ role: 'user', content: `f${i}` });
    }

    await writer.flush();

    const transcriptPath = getTranscriptPath(sessionId, TEST_CWD);
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(10);
  });

  it('flush() on a fresh writer with no work resolves immediately', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const writer = new TranscriptWriter(sessionId, TEST_CWD);
    await expect(writer.flush()).resolves.toBeUndefined();
  });

  it('returns the same UUID from the write promise as appears on disk (parentUuid chain)', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const writer = new TranscriptWriter(sessionId, TEST_CWD);

    const u1 = await writer.writeUserMessage({ role: 'user', content: 'a' });
    const u2 = await writer.writeAssistantMessage({ role: 'assistant', content: 'b' });

    const transcriptPath = getTranscriptPath(sessionId, TEST_CWD);
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    const [line1, line2] = raw.trim().split('\n');
    const e1 = JSON.parse(line1!) as Record<string, unknown>;
    const e2 = JSON.parse(line2!) as Record<string, unknown>;
    expect(e1.uuid).toBe(u1);
    expect(e1.parentUuid).toBeNull();
    expect(e2.uuid).toBe(u2);
    expect(e2.parentUuid).toBe(u1);
  });

  it('reads old transcripts without metadata fields without error', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const sessionId = randomUUID();
    const transcriptPath = getTranscriptPath(sessionId, TEST_CWD);

    await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
    // Write a legacy entry without metadata fields
    const legacyEntry = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'legacy message' },
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      isSidechain: false,
    });
    await fs.promises.writeFile(transcriptPath, legacyEntry + '\n', 'utf8');

    const messages = await readStoredHistory(sessionId, TEST_CWD);
    expect(messages).toHaveLength(1);
    expect(messages![0].content).toBe('legacy message');
  });
});

// ---------------------------------------------------------------------------
// Archived transcript reading
// ---------------------------------------------------------------------------

describe('archived transcript paths', () => {
  it('getLegacyRecordDirectory nests under <parentSessionId>/subagents/', () => {
    const parentId = randomUUID();
    const d = getLegacyRecordDirectory(parentId, TEST_CWD);
    expect(d).toContain(parentId);
    expect(d).toContain('subagents');
    expect(d).toContain('-test-project-dir');
  });

  it('getLegacyRecordPath uses agent- prefix and .jsonl suffix', () => {
    const parentId = randomUUID();
    const agentId = `agent-${Date.now()}-abc123`;
    const p = getLegacyRecordPath(parentId, agentId, TEST_CWD);
    expect(p).toContain(parentId);
    expect(p).toContain(`agent-${agentId}.jsonl`);
  });
});

describe('archived transcript reading', () => {
  it('reads a stored related transcript', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const parentId = randomUUID();
    const agentId = `agent-${Date.now()}-xyz`;

    const messages: Record<string, unknown>[] = [
      { type: 'assistant', message: { role: 'assistant', content: 'I will help.' }, uuid: randomUUID() },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, uuid: randomUUID() },
    ];

    await seedArchive(parentId, agentId, TEST_CWD, messages);

    const ids = await listLegacyRecordIds(parentId, TEST_CWD);
    expect(ids).toContain(agentId);

    const read = await readLegacyRecordMessages(parentId, agentId, TEST_CWD);
    expect(read).toHaveLength(2);
    expect(read[0].type).toBe('assistant');
    expect(read[0].session_id).toBe(agentId);
    expect(read[1].type).toBe('user');
  });

  it('listLegacyRecordIds returns empty array when no archived records exist', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const ids = await listLegacyRecordIds(randomUUID(), TEST_CWD);
    expect(ids).toEqual([]);
  });

  it('readLegacyRecordMessages returns empty array when transcript missing', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const result = await readLegacyRecordMessages(randomUUID(), 'no-such-agent', TEST_CWD);
    expect(result).toEqual([]);
  });

  it('skips non-message entries (result, system) when reading', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const parentId = randomUUID();
    const agentId = `agent-${Date.now()}-skip`;

    const messages: Record<string, unknown>[] = [
      { type: 'assistant', message: { role: 'assistant', content: 'hello' }, uuid: randomUUID() },
      { type: 'result', message: null, uuid: randomUUID() },    // should be skipped
      { type: 'system', message: null, uuid: randomUUID() },    // should be skipped
    ];

    await seedArchive(parentId, agentId, TEST_CWD, messages);

    const read = await readLegacyRecordMessages(parentId, agentId, TEST_CWD);
    expect(read).toHaveLength(1);
    expect(read[0].type).toBe('assistant');
  });

  it('pagination with limit and offset works', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const parentId = randomUUID();
    const agentId = `agent-${Date.now()}-page`;

    const messages: Record<string, unknown>[] = [
      { type: 'assistant', message: { role: 'assistant', content: 'msg1' }, uuid: randomUUID() },
      { type: 'user', message: { role: 'user', content: 'msg2' }, uuid: randomUUID() },
      { type: 'assistant', message: { role: 'assistant', content: 'msg3' }, uuid: randomUUID() },
    ];
    await seedArchive(parentId, agentId, TEST_CWD, messages);

    const page = await readLegacyRecordMessages(parentId, agentId, TEST_CWD, { limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
    expect((page[0].message as Record<string, unknown>).content).toBe('msg2');
    expect((page[1].message as Record<string, unknown>).content).toBe('msg3');
  });

  it('lists all archived records associated with one source', async () => {
    const dir = withTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const parentId = randomUUID();
    const agentA = `agent-${Date.now()}-a`;
    const agentB = `agent-${Date.now()}-b`;

    const msg: Record<string, unknown>[] = [
      { type: 'assistant', message: { role: 'assistant', content: 'hi' }, uuid: randomUUID() },
    ];
    await seedArchive(parentId, agentA, TEST_CWD, msg);
    await seedArchive(parentId, agentB, TEST_CWD, msg);

    const ids = await listLegacyRecordIds(parentId, TEST_CWD);
    expect(ids).toContain(agentA);
    expect(ids).toContain(agentB);
    expect(ids).toHaveLength(2);
  });
});
