/**
 * Unit tests for session metadata sidecar (renameSession / tagSession).
 *
 * Uses a temp directory for CLAUDE_CONFIG_DIR so tests don't pollute the
 * user's real session store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Dynamic import of the tested functions to allow env override before load
// ---------------------------------------------------------------------------

// Import after setting env so the config-dir resolver picks up our temp dir.
// We import directly (not via the re-export chain) so we don't need the full
// SDK to be bootable.
import {
  renameSession,
  tagSession,
  getSessionInfo,
  listSessions,
  getSessionMessages,
  getArchivedRecordMessages,
  listArchivedRecords,
  forkSession,
} from '../index.js';
import { getTranscriptPath, getLegacyRecordPath } from './transcript.js';
import { writeArchivedFixture } from '../validation/fixtures/archived-transcripts.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir = '';
let savedConfigDir: string | undefined;

/** Create a minimal (empty) transcript file so the session is "visible". */
async function createFakeTranscript(cwd: string, sessionId: string): Promise<void> {
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = join(tmpDir, 'projects', projectDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${sessionId}.jsonl`), '', 'utf-8');
}

/** Create a transcript with a real user message so firstPrompt can be extracted. */
async function createTranscriptWithPrompt(
  cwd: string,
  sessionId: string,
  promptText: string,
): Promise<void> {
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = join(tmpDir, 'projects', projectDir);
  await mkdir(dir, { recursive: true });
  const entry = JSON.stringify({
    type: 'user',
    uuid: 'uuid-test-1',
    sessionId,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    isSidechain: false,
    message: { role: 'user', content: promptText },
  });
  await writeFile(join(dir, `${sessionId}.jsonl`), entry + '\n', 'utf-8');
}

beforeEach(async () => {
  // Create a fresh temp directory and redirect CLAUDE_CONFIG_DIR
  tmpDir = await mkdtemp(join(tmpdir(), 'sdk-meta-test-'));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  // Restore env and remove temp directory
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session storage options', () => {
  it('rejects unsupported worktree enumeration instead of silently ignoring it', async () => {
    await expect(listSessions({ cwd: tmpDir, includeWorktrees: true })).rejects.toThrow(/not supported/);
  });

  it('isolates listing, reads, mutations and archives using env and conventions', async () => {
    const cwd = tmpDir;
    const sessionId = 'isolated-session';
    const options = {
      cwd,
      env: { SDK_STORE: join(tmpDir, 'isolated') },
      conventions: { configDirEnv: 'SDK_STORE' },
    };
    const transcript = getTranscriptPath(sessionId, cwd, options);
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(transcript, JSON.stringify({
      type: 'user',
      uuid: 'isolated-user',
      sessionId,
      message: { role: 'user', content: 'isolated prompt' },
    }) + '\n');

    await renameSession(sessionId, 'Isolated title', options);
    await tagSession(sessionId, 'isolated-tag', options);
    expect(await getSessionInfo(sessionId, options)).toMatchObject({
      customTitle: 'Isolated title', tag: 'isolated-tag', firstPrompt: 'isolated prompt',
    });
    expect(await listSessions(options)).toMatchObject([{ sessionId, customTitle: 'Isolated title' }]);
    expect(await getSessionMessages(sessionId, options)).toMatchObject([
      { message: { content: 'isolated prompt' } },
    ]);
    const fork = await forkSession(sessionId, options);
    expect(await getSessionMessages(fork.sessionId, options)).toHaveLength(1);

    await writeArchivedFixture(getLegacyRecordPath(sessionId, 'archived-record', cwd, options), 'archived-record', [{
      type: 'assistant', message: { role: 'assistant', content: 'archived answer' },
    }]);
    expect(await listArchivedRecords(sessionId, options)).toEqual(['archived-record']);
    expect(await getArchivedRecordMessages(sessionId, 'archived-record', options)).toMatchObject([
      { message: { content: 'archived answer' } },
    ]);
    expect(await listSessions({ cwd })).toEqual([]);
    expect(await getSessionInfo(sessionId, { cwd })).toBeUndefined();
    expect(await listArchivedRecords(sessionId, { cwd })).toEqual([]);
  });
});

describe('renameSession', () => {
  it('writes a custom title to the metadata sidecar', async () => {
    const cwd = '/test/project';
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await createFakeTranscript(cwd, sessionId);

    await renameSession(sessionId, 'My Custom Title', { cwd });

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info).toBeDefined();
    expect(info?.customTitle).toBe('My Custom Title');
  });

  it('overwrites an existing title', async () => {
    const cwd = '/test/project';
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000002';
    await createFakeTranscript(cwd, sessionId);

    await renameSession(sessionId, 'First Title', { cwd });
    await renameSession(sessionId, 'Updated Title', { cwd });

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info?.customTitle).toBe('Updated Title');
  });

  it('does not throw when transcript does not exist', async () => {
    // No transcript created — renameSession should be silent
    await expect(
      renameSession('nonexistent-session', 'Title', { cwd: '/missing' }),
    ).resolves.toBeUndefined();
  });
});

describe('tagSession', () => {
  it('writes a tag to the metadata sidecar', async () => {
    const cwd = '/test/project';
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000001';
    await createFakeTranscript(cwd, sessionId);

    await tagSession(sessionId, 'important', { cwd });

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info?.tag).toBe('important');
  });

  it('clears the tag when null is passed', async () => {
    const cwd = '/test/project';
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000002';
    await createFakeTranscript(cwd, sessionId);

    await tagSession(sessionId, 'to-remove', { cwd });
    await tagSession(sessionId, null, { cwd });

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info?.tag).toBeUndefined();
  });

  it('title and tag can coexist in the sidecar', async () => {
    const cwd = '/test/project';
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000003';
    await createFakeTranscript(cwd, sessionId);

    await renameSession(sessionId, 'My Session', { cwd });
    await tagSession(sessionId, 'wip', { cwd });

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info?.customTitle).toBe('My Session');
    expect(info?.tag).toBe('wip');
  });
});

describe('listSessions with metadata', () => {
  it('includes customTitle from sidecar in listing', async () => {
    const cwd = '/test/project';
    const s1 = 'cccccccc-0000-0000-0000-000000000001';
    const s2 = 'cccccccc-0000-0000-0000-000000000002';
    await createFakeTranscript(cwd, s1);
    await createFakeTranscript(cwd, s2);

    await renameSession(s1, 'Session One', { cwd });
    await tagSession(s2, 'archived', { cwd });

    const sessions = await listSessions({ cwd });
    const info1 = sessions.find(s => s.sessionId === s1);
    const info2 = sessions.find(s => s.sessionId === s2);

    expect(info1?.customTitle).toBe('Session One');
    expect(info1?.tag).toBeUndefined();
    expect(info2?.customTitle).toBeUndefined();
    expect(info2?.tag).toBe('archived');
  });
});

describe('SDKSessionInfo timestamp types (SDK contract)', () => {
  it('lastModified is a number (ms since epoch), not a string', async () => {
    const cwd = '/test/project';
    const sessionId = 'dddddddd-0000-0000-0000-000000000001';
    await createFakeTranscript(cwd, sessionId);

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info).toBeDefined();
    expect(typeof info?.lastModified).toBe('number');
    expect(info!.lastModified).toBeGreaterThan(0);
  });

  it('createdAt is a number (ms since epoch), not a string', async () => {
    const cwd = '/test/project';
    const sessionId = 'dddddddd-0000-0000-0000-000000000002';
    await createFakeTranscript(cwd, sessionId);

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info).toBeDefined();
    expect(typeof info?.createdAt).toBe('number');
    expect(info!.createdAt).toBeGreaterThan(0);
  });

  it('listSessions returns numeric timestamps', async () => {
    const cwd = '/test/project';
    const sessionId = 'dddddddd-0000-0000-0000-000000000003';
    await createFakeTranscript(cwd, sessionId);

    const sessions = await listSessions({ cwd });
    const found = sessions.find(s => s.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(typeof found?.lastModified).toBe('number');
    expect(found!.lastModified).toBeGreaterThan(0);
  });
});

describe('SDKSessionInfo firstPrompt and summary', () => {
  it('populates firstPrompt from the first user message in transcript', async () => {
    const cwd = '/test/project';
    const sessionId = 'eeeeeeee-0000-0000-0000-000000000001';
    await createTranscriptWithPrompt(cwd, sessionId, 'Write me a haiku.');

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info).toBeDefined();
    expect(info?.firstPrompt).toBe('Write me a haiku.');
  });

  it('summary falls back to firstPrompt when no customTitle', async () => {
    const cwd = '/test/project';
    const sessionId = 'eeeeeeee-0000-0000-0000-000000000002';
    await createTranscriptWithPrompt(cwd, sessionId, 'Explain quantum entanglement.');

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info?.summary).toBe('Explain quantum entanglement.');
  });

  it('summary prefers customTitle over firstPrompt', async () => {
    const cwd = '/test/project';
    const sessionId = 'eeeeeeee-0000-0000-0000-000000000003';
    await createTranscriptWithPrompt(cwd, sessionId, 'Some long prompt text.');
    await renameSession(sessionId, 'My Custom Title', { cwd });

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info?.summary).toBe('My Custom Title');
    expect(info?.firstPrompt).toBe('Some long prompt text.');
  });

  it('summary falls back to sessionId when transcript is empty', async () => {
    const cwd = '/test/project';
    const sessionId = 'eeeeeeee-0000-0000-0000-000000000004';
    await createFakeTranscript(cwd, sessionId);

    const info = await getSessionInfo(sessionId, { cwd });
    expect(info?.summary).toBe(sessionId);
    expect(info?.firstPrompt).toBeUndefined();
  });

  it('listSessions includes firstPrompt for sessions with content', async () => {
    const cwd = '/test/project';
    const s1 = 'ffffffff-0000-0000-0000-000000000001';
    const s2 = 'ffffffff-0000-0000-0000-000000000002';
    await createTranscriptWithPrompt(cwd, s1, 'Hello, world!');
    await createFakeTranscript(cwd, s2);

    const sessions = await listSessions({ cwd });
    const i1 = sessions.find(s => s.sessionId === s1);
    const i2 = sessions.find(s => s.sessionId === s2);

    expect(i1?.firstPrompt).toBe('Hello, world!');
    expect(i1?.summary).toBe('Hello, world!');
    expect(i2?.firstPrompt).toBeUndefined();
    expect(i2?.summary).toBe(s2);
  });
});

describe('tool context and public session metadata', () => {
  it('skips a large internal directory while preserving the first real user request', async () => {
    const cwd = '/test/project';
    const sessionId = 'tool-context-directory';
    await createFakeTranscript(cwd, sessionId);
    const filePath = getTranscriptPath(sessionId, cwd);
    const records = [
      { type: 'user', message: { role: 'user', isMeta: true, content: 'Private service directory. '.repeat(1500),
        toolContext: { version: 1, baselineAttachment: true, baseline: { directory: 'Private service directory.' } } } },
      { type: 'user', message: { role: 'user', content: 'Find customer 42.' } },
    ];
    await writeFile(filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    expect(await getSessionInfo(sessionId, { cwd })).toMatchObject({ firstPrompt: 'Find customer 42.', summary: 'Find customer 42.' });
    expect((await listSessions({ cwd }))[0]).toMatchObject({ firstPrompt: 'Find customer 42.' });
  });

  it('keeps an ordinary first user message carrying a private empty baseline', async () => {
    const cwd = '/test/project';
    const sessionId = 'tool-context-eager';
    await createFakeTranscript(cwd, sessionId);
    await writeFile(getTranscriptPath(sessionId, cwd), JSON.stringify({ type: 'user', message: {
      role: 'user', content: [{ type: 'text', text: '用户真正的请求。' }],
      toolContext: { version: 1, baseline: { directory: '', definitions: [] } },
    } }));
    expect(await getSessionInfo(sessionId, { cwd })).toMatchObject({ firstPrompt: '用户真正的请求。' });
  });

  it('keeps metadata reads bounded when a leading internal record is too large', async () => {
    const cwd = '/test/project';
    const sessionId = 'tool-context-oversized';
    await createFakeTranscript(cwd, sessionId);
    await writeFile(getTranscriptPath(sessionId, cwd), JSON.stringify({ type: 'user', message: {
      role: 'user', isMeta: true, content: 'Private directory. '.repeat(30_000),
      toolContext: { version: 1, baselineAttachment: true },
    } }) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'Later request.' } }) + '\n');
    const info = await getSessionInfo(sessionId, { cwd });
    expect(info?.firstPrompt).toBeUndefined();
    expect(info?.summary).toBe(sessionId);
  });

  it('refuses an unknown fork anchor and leaves no incomplete destination transcript', async () => {
    const cwd = '/test/project';
    const sessionId = 'unknown-fork-anchor';
    await createTranscriptWithPrompt(cwd, sessionId, 'Original request.');
    const before = (await listSessions({ cwd })).map(session => session.sessionId);
    await expect(forkSession(sessionId, { cwd, upToMessageId: 'missing' })).rejects.toThrow('fork message was not found');
    expect((await listSessions({ cwd })).map(session => session.sessionId)).toEqual(before);
  });

  it('copies a valid anchored prefix without later discovery records', async () => {
    const cwd = '/test/project';
    const sessionId = 'valid-fork-anchor';
    await createFakeTranscript(cwd, sessionId);
    await writeFile(getTranscriptPath(sessionId, cwd), [
      { type: 'user', uuid: 'early', message: { role: 'user', content: 'First task.' } },
      { type: 'user', uuid: 'late', message: { role: 'user', content: 'Later discovery.', toolContext: { version: 1 } } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const fork = await forkSession(sessionId, { cwd, upToMessageId: 'early' });
    expect(await getSessionMessages(fork.sessionId, { cwd })).toMatchObject([{ uuid: 'early', message: { content: 'First task.' } }]);
    expect(await getSessionMessages(fork.sessionId, { cwd })).toHaveLength(1);
  });
});
