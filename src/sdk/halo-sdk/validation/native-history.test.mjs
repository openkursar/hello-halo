import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const api = await import(pathToFileURL(join(compiled, 'native/history.js')).href);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-history-'));
  const cwd = '/fixture/history';
  const options = { cwd, env: { HISTORY_STORE: root }, conventions: { configDirEnv: 'HISTORY_STORE' } };
  const directory = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(directory, { recursive: true });
  return { root, options, directory, file: id => join(directory, `${id}.jsonl`), close: () => rm(root, { recursive: true, force: true }) };
}
const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, sessionId: 'source', message: { role: 'user', content }, ...extra });
const lines = entries => entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n';

test('native history metadata, aliases and archives use the configured storage without creating execution state', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file('source'), lines([user('first', '  Actual request 中文😀  ')]));
    await api.renameSession('source', 'Chosen title', f.options);
    await api.tagSession('source', 'review', f.options);
    const info = await api.getSessionInfo('source', f.options);
    assert.equal(info.customTitle, 'Chosen title'); assert.equal(info.summary, 'Chosen title'); assert.equal(info.tag, 'review');
    assert.equal(info.firstPrompt, 'Actual request 中文😀');
    assert.equal(typeof info.createdAt, 'number'); assert.equal(typeof info.lastModified, 'number');
    assert.equal(info.fileSize, (await stat(f.file('source'))).size);
    const alias = { ...f.options, cwd: '/wrong', dir: f.options.cwd };
    assert.equal((await api.listSessions(alias))[0].sessionId, 'source');
    assert.equal((await api.getSessionMessages('source', alias))[0].message.content, '  Actual request 中文😀  ');
    await api.tagSession('source', null, f.options); assert.equal((await api.getSessionInfo('source', f.options)).tag, undefined);
    const archive = join(f.directory, 'source', 'subagents', 'agent-reader.jsonl'); await mkdir(dirname(archive), { recursive: true });
    await writeFile(archive, lines([{ type: 'assistant', uuid: 'old', message: { content: 'archived' } }]));
    assert.deepEqual(await api.listArchivedRecords('source', alias), ['reader']);
    assert.equal((await api.getArchivedRecordMessages('source', 'reader', alias))[0].session_id, 'reader');
    const other = { ...f.options, env: { HISTORY_STORE: join(f.root, 'other') } };
    assert.deepEqual(await api.listSessions(other), []); assert.equal(await api.getSessionInfo('source', other), undefined);
    assert.deepEqual(await api.listArchivedRecords('source', other), []);
    assert.equal(await api.renameSession('absent', 'metadata only', other), undefined);
    assert.equal(await api.getSessionInfo('absent', other), undefined);
    await assert.rejects(api.listSessions({ ...f.options, includeWorktrees: true }), /not supported/);
  } finally { await f.close(); }
});

test('native transcript pages retain response metadata scope and exclude private checkpoints and directories', async () => {
  const f = await fixture();
  try {
    const entries = [
      { type: 'user', message: { role: 'user', content: 'private directory', isMeta: true, toolContext: { baselineAttachment: true } } },
      user('first', 'real request'),
      { type: 'assistant', uuid: 'one', responseUuid: 'reply', sessionId: 'source', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
      { type: 'assistant', uuid: 'two', responseUuid: 'reply', sessionId: 'source', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
      { type: 'compact_checkpoint', summary: 'private checkpoint', messages: [{ role: 'user', content: 'summary' }] },
      { type: 'assistant_metadata', responseUuid: 'reply', sessionId: 'other', message: { usage: { output_tokens: 999 } } },
      { type: 'assistant_metadata', responseUuid: 'reply', sessionId: 'source', message: { id: 'final', model: 'fixture', usage: { output_tokens: 7 } } },
      'damaged-record',
    ];
    await writeFile(f.file('source'), lines(entries));
    const page = await api.getSessionMessages('source', f.options); assert.equal(page.length, 3);
    assert.equal(page[1].message.usage, undefined); assert.deepEqual(page[2].message.usage, { output_tokens: 7 });
    assert.deepEqual(await api.getSessionMessages('source', { ...f.options, offset: 2, limit: 1 }), [page[2]]);
    assert.equal((await api.getSessionMessages('source', { ...f.options, offset: 1, limit: 1 }))[0].message.usage, undefined);
    assert.deepEqual(await api.getSessionMessages('source', { ...f.options, limit: 0 }), []);
    for (const values of [{ offset: -1 }, { offset: 1.5 }, { limit: 4097 }, { limit: Infinity }]) {
      await assert.rejects(api.getSessionMessages('source', { ...f.options, ...values }), error => error instanceof RangeError && /pagination/.test(error.message));
    }
    assert.equal((await api.getSessionInfo('source', f.options)).firstPrompt, 'real request');
  } finally { await f.close(); }
});

test('native forks preserve malformed lines and clean failed anchored copies', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file('source'), lines([user('first', 'first'), 'malformed', user('last', 'last')]));
    const before = (await readdir(f.directory)).sort();
    await assert.rejects(api.forkSession('source', { ...f.options, upToMessageId: 'missing' }), /fork message was not found/);
    assert.deepEqual((await readdir(f.directory)).sort(), before);
    const anchored = await api.forkSession('source', { ...f.options, upToMessageId: 'first' });
    const page = await api.getSessionMessages(anchored.sessionId, f.options); assert.equal(page.length, 1); assert.equal(page[0].session_id, anchored.sessionId);
    const full = await api.forkSession('source', f.options); const copied = await readFile(f.file(full.sessionId), 'utf8');
    assert.ok(copied.includes('\nmalformed\n')); assert.ok(!copied.includes('"sessionId":"source"'));
    if (process.platform !== 'win32') assert.equal((await stat(f.file(full.sessionId))).mode & 0o777, 0o600);
    await assert.rejects(api.forkSession('absent', f.options), /ENOENT/);
  } finally { await f.close(); }
});

test('native history treats nested transport-shaped objects as literal disk data', async () => {
  const f = await fixture();
  try {
    const content = [{ type: 'text', text: { __haloSdkNativeUndefined: true } }, { type: 'tool_result', content: { __haloSdkNativeNumber: 'NaN' } }];
    await writeFile(f.file('source'), lines([user('literal', content)]));
    assert.deepEqual((await api.getSessionMessages('source', f.options))[0].message.content, content);
    assert.equal((await api.getSessionInfo('source', f.options)).firstPrompt, '[object Object]');
    const title = { __haloSdkNativeUndefined: true }; const tag = { __haloSdkNativeNumber: 'NaN' };
    await writeFile(join(f.directory, 'source.meta.json'), JSON.stringify({ title, tag }));
    const info = await api.getSessionInfo('source', f.options); assert.deepEqual(info.customTitle, title); assert.deepEqual(info.tag, tag);
    const fork = await api.forkSession('source', f.options);
    assert.deepEqual((await api.getSessionMessages(fork.sessionId, f.options))[0].message.content, content);
    await api.tagSession('source', 'updated', f.options);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'source.meta.json'), 'utf8')).title, title);
  } finally { await f.close(); }
});

test('native first-prompt extraction stops before an oversized leading internal record', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file('source'), lines([{ type: 'user', message: { role: 'user', content: 'x'.repeat(300_000), isMeta: true, toolContext: { baselineAttachment: true } } }, user('later', 'beyond prefix')]));
    const info = await api.getSessionInfo('source', f.options); assert.equal(info.firstPrompt, undefined); assert.equal(info.summary, 'source');
  } finally { await f.close(); }
});
