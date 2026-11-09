import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../../utils/logger.js';

export const MAX_BACKGROUND_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_RETAINED_OUTPUT_BYTES = 256 * 1024 * 1024;
export const MAX_RETAINED_OUTPUT_FILES = 128;
export const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const log = getLogger('BashOutput');

/** Only completed SDK output is disposable; active files have no completion marker. */
export async function pruneOutput(directory: string, now = Date.now()): Promise<void> {
  try {
    const files = await fs.readdir(directory);
    for (const name of files) {
      const active = /^(bash-[0-9a-f-]+\.output)\.active-(\d+)$/.exec(name);
      if (!active) continue;
      try { process.kill(Number(active[2]), 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        const marker = `${active[1]}.done`;
        await fs.writeFile(join(directory, marker), '', { mode: 0o600 });
        await fs.rm(join(directory, name), { force: true });
        files.push(marker);
        log.warn('orphaned command output reclaimed', { taskId: active[1] });
      }
    }
    const marked = new Set(files.filter(name => /\.done$|\.active-\d+$/.test(name))
      .map(name => name.replace(/\.done$|\.active-\d+$/, '')));
    for (const name of files) {
      if (!/^bash-[0-9a-f-]+\.output$/.test(name) || marked.has(name)) continue;
      try {
        const stat = await fs.lstat(join(directory, name));
        // A process can die between opening the output and publishing its child PID.
        if (stat.isFile() && now - stat.mtimeMs > OUTPUT_RETENTION_MS) {
          await fs.rm(join(directory, name), { force: true });
          log.warn('abandoned command output removed', { file: name });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const completed: Array<{ path: string; marker: string; bytes: number; modified: number }> = [];
    for (const name of new Set(files)) {
      if (!/^bash-[0-9a-f-]+\.output\.done$/.test(name)) continue;
      const marker = join(directory, name);
      const path = marker.slice(0, -5);
      try {
        const stat = await fs.lstat(path);
        if (stat.isFile()) completed.push({ path, marker, bytes: stat.size, modified: stat.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.rm(marker, { force: true });
      }
    }
    completed.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
    let bytes = 0;
    let count = 0;
    let removed = 0;
    for (const file of completed) {
      if (now - file.modified > OUTPUT_RETENTION_MS || count >= MAX_RETAINED_OUTPUT_FILES ||
          bytes + file.bytes > MAX_RETAINED_OUTPUT_BYTES) {
        await fs.rm(file.path, { force: true });
        await fs.rm(file.marker, { force: true });
        removed++;
      } else {
        bytes += file.bytes;
        count++;
      }
    }
    if (removed) log.warn('expired or over-budget command output removed', { removed, retainedFiles: count, retainedBytes: bytes });
  } catch (error) {
    log.warn('command output retention failed', { error: String(error) });
    throw error;
  }
}
