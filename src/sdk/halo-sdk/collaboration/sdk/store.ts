import { mkdir, open, stat, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readJsonl } from '../../utils/jsonl-reader.js';
import { acquireSessionOwnership } from '../../utils/session-ownership.js';
import { MemoryScopeStore, type CollaborationMutation } from '../memory-store.js';

const memberStates = new Set(['idle', 'queued', 'running', 'stopped', 'error']);
const taskStates = new Set(['pending', 'in_progress', 'done', 'rejected', 'blocked']);
const activityKinds = new Set(['message', 'reply', 'task_post', 'task_update', 'finding', 'check_set', 'check_stop', 'run_end', 'decision']);

function mutationFrom(value: unknown): CollaborationMutation {
  if (!value || typeof value !== 'object') throw new Error('Malformed collaboration journal mutation');
  const mutation = value as Record<string, unknown>;
  const row = mutation.value as Record<string, unknown> | undefined;
  const id = mutation.kind === 'remove_member' ? mutation.id : row?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid collaboration journal identity');
  if (mutation.kind === 'remove_member') return { kind: 'remove_member', id };
  if (!row || typeof row !== 'object') throw new Error('Missing collaboration journal row');
  const string = (key: string) => typeof row[key] === 'string';
  if (mutation.kind === 'member') {
    if (!['name', 'parentId', 'prompt'].every(string) || !Number.isFinite(row.createdAt)
      || (row.state !== undefined && !memberStates.has(String(row.state)))
      || (row.cwd !== undefined && !string('cwd'))
      || (row.model !== undefined && !string('model'))
      || (row.workingDirectory !== undefined && !string('workingDirectory'))
      || (row.worktreePath !== undefined && !string('worktreePath'))
      || (row.isolation !== undefined && row.isolation !== 'worktree')
      || (row.origin !== undefined && row.origin !== 'guest' && row.origin !== 'colleague')) throw new Error('Invalid collaborator record');
  } else {
    if (!string('teamId') || !string('epochId') || !Number.isFinite(row.createdAt)) throw new Error('Invalid collaboration scope record');
    if (mutation.kind === 'task') {
      if (!string('title') || !taskStates.has(String(row.status)) || !string('createdByAppId')) throw new Error('Invalid collaboration task');
    } else if (mutation.kind === 'finding') {
      if (!string('authorAppId')) throw new Error('Invalid collaboration finding');
    } else if (mutation.kind === 'activity') {
      if (!activityKinds.has(String(row.kind)) || !string('actorAppId') || !string('subject')) throw new Error('Invalid collaboration activity');
    } else throw new Error('Unknown collaboration journal mutation');
  }
  return mutation as unknown as CollaborationMutation;
}

export interface FileScopeStoreHandle {
  store: MemoryScopeStore;
  close(): Promise<void>;
}

/** Incremental persistence; a successful flush does not depend on rewriting accumulated history. */
export async function openFileScopeStore(options: {
  path: string;
  teamId: string;
  epochId: string;
  signal?: AbortSignal;
  maxRecords?: number;
  maxBytes?: number;
}): Promise<FileScopeStoreHandle> {
  const signal = options.signal ?? new AbortController().signal;
  const release = await acquireSessionOwnership(options.path, signal, options.epochId);
  let handle: FileHandle | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let separator = false;
  let failed: unknown;
  try {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    const store = new MemoryScopeStore({
      teamId: options.teamId, epochId: options.epochId, maxRecords: options.maxRecords, maxBytes: options.maxBytes,
      persist: async mutations => {
        if (closed) throw new Error('Collaboration journal is closed');
        if (failed) throw failed;
        const before = (await handle!.stat()).size;
        const batch = `${separator ? '\n' : ''}${mutations.map(mutation => JSON.stringify({ type: 'mutation', version: 1, mutation })).join('\n')}\n`;
        try {
          await handle!.appendFile(batch, 'utf8');
          await handle!.sync();
          separator = false;
        } catch (error) {
          try { await handle!.truncate(before); await handle!.sync(); }
          catch (rollbackError) {
            failed = new Error('Collaboration journal rollback failed; reopen and inspect before continuing.', { cause: rollbackError });
            console.error('[Collaboration] Journal rollback failed', rollbackError);
          }
          throw error;
        }
      },
    });
    let size = 0;
    try { size = (await stat(options.path)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (size > 0) {
      let header = false;
      let damaged: { at: number; line: string } | undefined;
      for await (const record of readJsonl(options.path)) {
        signal.throwIfAborted();
        if (damaged) throw new Error('The collaboration journal contains a damaged non-final record.');
        if (!record.value) {
          damaged = { at: record.start, line: record.line };
          continue;
        }
        if (!header) {
          if (record.value.type !== 'scope' || record.value.version !== 1 || record.value.teamId !== options.teamId || record.value.epochId !== options.epochId) {
            throw new Error('The collaboration journal scope or version does not match.');
          }
          header = true;
        } else {
          if (record.value.type !== 'mutation' || record.value.version !== 1) throw new Error('Unsupported collaboration journal record');
          store.apply(mutationFrom(record.value.mutation));
        }
        separator = !record.terminated;
      }
      if (!header) throw new Error('The collaboration journal header is unavailable.');
      if (damaged) {
        const recovery = `${options.path}.recovery-${Date.now()}`;
        await writeFile(recovery, damaged.line, { flag: 'wx', mode: 0o600 });
        await truncate(options.path, damaged.at);
        console.warn(`[Collaboration] Incomplete final journal record preserved separately: epoch=${options.epochId} bytes=${Buffer.byteLength(damaged.line)}`);
        separator = false;
      }
    }
    handle = await open(options.path, 'a+', 0o600);
    if (size === 0) {
      await handle.appendFile(`${JSON.stringify({ type: 'scope', version: 1, teamId: options.teamId, epochId: options.epochId })}\n`, 'utf8');
      await handle.sync();
    }
    signal.throwIfAborted();
    return {
      store,
      close() {
        closing ??= (async () => {
          try { await store.flush(); }
          finally {
            closed = true;
            try { await handle!.close(); } finally { release(); }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await handle?.close().catch(closeError => console.warn('[Collaboration] Failed opening journal cleanup', closeError));
    release();
    throw error;
  }
}
