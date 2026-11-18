import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getLogger } from './logger.js';

export interface ProcessTreeContext { windowsPosixBin?: string }

export function processTreeContext(executable: string): ProcessTreeContext | undefined {
  if (process.platform !== 'win32' || !/^(?:bash|sh)\.exe$/i.test(basename(executable))) return undefined;
  const directory = dirname(executable);
  for (const bin of [directory, join(directory, '..', 'usr', 'bin')]) {
    if (existsSync(join(bin, 'ps.exe'))) return { windowsPosixBin: bin };
  }
  return undefined;
}

function run(executable: string, args: string[], timeout = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

const snapshots = new Map<string, Promise<string>>();
function snapshot(key: string, read: () => Promise<string>): Promise<string> {
  const pending = snapshots.get(key);
  if (pending) return pending;
  const result = read().finally(() => snapshots.delete(key));
  snapshots.set(key, result);
  return result;
}

/** MSYS fork/exec can replace a native parent; retain both ancestry graphs. */
export function ownedWindowsProcesses(root: number, native: Array<{ pid: number; parent: number }>, posix: string): number[] {
  const rows = posix.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), native: Number(match[3]) }] : [];
  });
  const owned = new Set([root]);
  const ownedPosix = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of native) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    for (const row of rows) if (owned.has(row.native) || ownedPosix.has(row.parent)) {
      if (!owned.has(row.native)) { owned.add(row.native); changed = true; }
      if (!ownedPosix.has(row.pid)) { ownedPosix.add(row.pid); changed = true; }
    }
  }
  return [...owned].filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
}

export async function killWindowsProcessTree(pid: number, context?: ProcessTreeContext): Promise<void> {
  let owned = [pid];
  if (context?.windowsPosixBin) {
    try {
      const native = await snapshot('native', () => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object @{n="pid";e={$_.ProcessId}},@{n="parent";e={$_.ParentProcessId}} | ConvertTo-Json -Compress'], 4000));
      // Sample POSIX ancestry after native discovery, including execs during shell startup.
      const ps = join(context.windowsPosixBin, 'ps.exe');
      const posix = await snapshot(ps, () => run(ps, ['-e']));
      const parsed = JSON.parse(native);
      owned = ownedWindowsProcesses(pid, Array.isArray(parsed) ? parsed : [parsed], posix);
    } catch (error) {
      getLogger('Processes').warn('POSIX process ancestry unavailable; using native tree termination', {
        pid, error: String(error), timedOut: !!(error as { killed?: boolean }).killed,
      });
    }
  }
  try { await run('taskkill.exe', [...owned.flatMap(value => ['/PID', String(value)]), '/T', '/F']); }
  catch (error) {
    // taskkill also fails when a process exited between enumeration and termination.
    const remaining = owned.filter(value => { try { process.kill(value, 0); return true; } catch { return false; } });
    if (remaining.length) getLogger('Processes').warn('Process tree termination incomplete', { pid, remaining, error: String(error) });
  }
}
