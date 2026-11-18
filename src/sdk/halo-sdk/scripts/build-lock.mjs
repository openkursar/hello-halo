import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const lockName = '.build-lock';

export function buildLockPath(sdk) {
  return join(sdk, lockName);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function ownerOf(directory) {
  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (files.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(files[0])) return null;
  try {
    const owner = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
    return { ...owner, file: files[0] };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function removeEmpty(directory) {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

async function removeOwner(directory, file) {
  try {
    await unlink(join(directory, file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // A delayed reclaimer cannot remove a successor's nonempty directory.
  await removeEmpty(directory);
}

/** A fully written owner is installed atomically; reclamation never deletes another owner's files. */
export async function acquireBuildLock(sdk, { timeoutMs = 30 * 60_000, pollMs = 500 } = {}) {
  const root = buildLockPath(sdk);
  const format = join(root, 'format-1');
  try {
    await mkdir(root);
    await mkdir(format);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let initialized = false;
    const deadline = Date.now() + Math.min(timeoutMs, 1_000);
    do {
      if ((await readdir(root)).includes('format-1')) {
        initialized = true;
        break;
      }
      await sleep(Math.min(pollMs, 10));
    } while (Date.now() < deadline);
    if (!initialized) throw new Error(`Legacy SDK build lock or interrupted initialization at ${root}; confirm its owner and child builds have stopped before removing it`);
  }
  try {
    await readFile(join(root, 'owner.json'));
    throw new Error(`Legacy SDK build lock at ${root}; confirm its owner and child builds have stopped before removing it`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const held = join(root, 'held');
  const candidate = await mkdtemp(join(root, 'candidate-'));
  const file = `owner-${randomUUID()}.json`;
  const startedAt = Date.now();
  let waiting = false;
  try {
    await writeFile(join(candidate, file), `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: process.argv.slice(1).join(' '),
    }, null, 2)}\n`);
    for (;;) {
      try {
        await rename(candidate, held);
        let released = false;
        return {
          async release() {
            if (released) return;
            released = true;
            try {
              await removeOwner(held, file);
            } catch (error) {
              console.warn(`[halo-sdk] Could not release ${held}: ${error.message}`);
            }
          },
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const owner = await ownerOf(held);
        if (owner && !processAlive(owner.pid)) {
          await removeOwner(held, owner.file);
          console.log(`[halo-sdk] Reclaimed the SDK build lock from exited process ${owner.pid}`);
          continue;
        }
        await removeEmpty(held);
        if (!waiting) {
          waiting = true;
          console.log(`[halo-sdk] Waiting for the SDK build${owner ? ` owned by process ${owner.pid}` : ' (owner unavailable)'}...`);
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`Timed out waiting for ${held}${owner ? ` (process ${owner.pid})` : '; inspect the unavailable owner before removing the lock'}`);
        }
        await sleep(pollMs);
      }
    }
  } finally {
    await rm(candidate, { recursive: true, force: true }).catch(error => {
      console.warn(`[halo-sdk] Could not remove the unpublished lock candidate ${candidate}: ${error.message}`);
    });
  }
}
