import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeScanResult } from '../../../shared/types/external-runtime';
import { RuntimeError } from './errors';
import { candidateExists, getRuntimeRoot } from './paths';
import type { RuntimeProvider } from './provider';
import type { createRuntimeProbe } from './probe';
export async function childDirectories(path: string, limit: number, signal: AbortSignal): Promise<{
  paths: string[];
  truncated: boolean;
}> {
  const paths: string[] = [];
  try {
    const directory = await opendir(path);
    if (signal.aborted) {
      await directory.close();
      return {
        paths,
        truncated: true
      };
    }
    let inspected = 0;
    for await (const entry of directory) {
      if (signal.aborted || ++inspected > 128) {
        return {
          paths,
          truncated: true
        };
      }
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      if (paths.length >= limit) {
        return {
          paths,
          truncated: true
        };
      }
      paths.push(join(path, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[ExternalRuntime] Discovery location unreadable', {
        code: (error as NodeJS.ErrnoException).code
      });
    }
  }
  return {
    paths,
    truncated: false
  };
}
export function createRuntimeDiscovery(provider: RuntimeProvider, probe: ReturnType<typeof createRuntimeProbe>) {
  async function discoverInstallations(selectedPath?: string, options: {
    signal?: AbortSignal;
    stopOnCompatible?: boolean;
    deadlineMs?: number;
  } = {}): Promise<RuntimeScanResult> {
    const controller = new AbortController(),
      progress: RuntimeScanResult = {
        installations: [],
        searchedLocations: 0,
        truncated: false
      };
    const snapshot = (truncated = progress.truncated) => ({
      installations: progress.installations.filter(Boolean).map(item => ({
        ...item
      })),
      searchedLocations: progress.searchedLocations,
      truncated
    });
    const abort = () => controller.abort(options.signal?.reason ?? new RuntimeError('cancelled'));
    options.signal?.addEventListener('abort', abort, {
      once: true
    });
    if (options.signal?.aborted) {
      abort();
    }
    const timeout = setTimeout(() => controller.abort(new RuntimeError('probe-timeout')), options.deadlineMs ?? 12000);
    let stopped: (() => void) | undefined;
    async function collect() {
      const signal = controller.signal;
      if (signal.aborted) {
        return;
      }
      const known = await provider.discoveryCandidates({
        selectedPath,
        root: getRuntimeRoot(provider),
        signal,
        childDirectories: (path, limit) => childDirectories(path, limit, signal)
      });
      if (signal.aborted) {
        return;
      }
      let truncated = known.truncated,
        invalid = 0;
      const candidates: string[] = [],
        resolved = new Set<string>();
      for (const path of [...new Set(known.paths)].slice(0, 64)) {
        if (signal.aborted) {
          return;
        }
        progress.searchedLocations++;
        if (!(await candidateExists(path))) {
          continue;
        }
        if (signal.aborted) {
          return;
        }
        if (candidates.length >= 12) {
          truncated = true;
          break;
        }
        try {
          const candidate = await provider.resolveCandidate(path);
          if (signal.aborted) {
            return;
          }
          if (!resolved.has(candidate.resolvedPath)) {
            resolved.add(candidate.resolvedPath);
            candidates.push(candidate.path);
          }
        } catch {
          invalid++;
        }
      }
      truncated ||= known.paths.length > 64;
      let next = 0,
        found = false;
      await Promise.all(Array.from({
        length: Math.min(options.stopOnCompatible ? 1 : 3, candidates.length)
      }, async () => {
        while (next < candidates.length && !signal.aborted && !found) {
          const index = next++,
            result = await probe.checkInstallation(candidates[index], {
              signal
            });
          if (signal.aborted) {
            break;
          }
          progress.installations[index] = result;
          if (options.stopOnCompatible && ['verified', 'compatible'].includes(result.compatibility)) {
            found = true;
          }
        }
      }));
      progress.truncated = truncated;
      if (!signal.aborted) {
        console.log('[ExternalRuntime] Bounded discovery completed', {
          runtimeId: provider.id,
          searched: progress.searchedLocations,
          found: progress.installations.length,
          invalid,
          truncated
        });
      }
    }
    try {
      return await Promise.race([collect().then(() => snapshot(controller.signal.aborted || progress.truncated)), new Promise<RuntimeScanResult>(resolve => {
        stopped = () => {
          console.warn('[ExternalRuntime] Discovery stopped; returning completed checks', {
            runtimeId: provider.id,
            searched: progress.searchedLocations,
            completed: progress.installations.filter(Boolean).length
          });
          resolve(snapshot(true));
        };
        if (controller.signal.aborted) {
          stopped();
        } else {
          controller.signal.addEventListener('abort', stopped, {
            once: true
          });
        }
      })]);
    } finally {
      clearTimeout(timeout);
      if (stopped) {
        controller.signal.removeEventListener('abort', stopped);
      }
      options.signal?.removeEventListener('abort', abort);
    }
  }
  return {
    discoverInstallations
  };
}
