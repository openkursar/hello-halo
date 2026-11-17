import { spawn } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { RuntimeInstallation, RuntimeLaunch } from '../../../shared/types/external-runtime';
import { updateEnvPath } from '../child-env';
import { RuntimeError, issueFromError } from './errors';
import { isManagedPath, normalizeInputPath } from './paths';
import type { ProbeProcess, ResolvedCandidate, RuntimeProbeRunner, RuntimeProvider } from './provider';
const CAPACITY = 24;
let active = 0;
const waiters: Array<() => void> = [];
function abortError(signal?: AbortSignal): RuntimeError {
  return signal?.reason instanceof RuntimeError ? signal.reason : new RuntimeError('cancelled');
}
async function acquire(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) {
    throw abortError(signal);
  }
  if (active >= 3) {
    if (waiters.length >= CAPACITY) {
      throw new RuntimeError('probe-busy');
    }
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const index = waiters.indexOf(start);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(abortError(signal));
      };
      waiters.push(start);
      signal.addEventListener('abort', abort, {
        once: true
      });
    });
  } else {
    active++;
  }
  return () => {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  };
}
function environment(directory: string, candidate: ResolvedCandidate, processEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: directory,
    USERPROFILE: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    XDG_CONFIG_HOME: directory,
    XDG_CACHE_HOME: directory,
    XDG_DATA_HOME: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1',
    ...candidate.launch.env,
    ...processEnv
  };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'CLAUDE_CODE_GIT_BASH_PATH']) if (process.env[key]) {
    env[key] = process.env[key];
  }
  if (candidate.launch.pathDirs?.length) {
    updateEnvPath(env, current => [...candidate.launch.pathDirs!, ...(current ? [current] : [])].join(delimiter));
  }
  return env;
}
function runProcess(candidate: ResolvedCandidate, directory: string, request: ProbeProcess, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.launch.command, [...candidate.launch.argsPrefix, ...request.args], {
      cwd: directory,
      env: environment(directory, candidate, request.env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '',
      buffer = '',
      bytes = 0;
    let done = false,
      settled = false;
    let outcome: {
      error?: unknown;
      value?: string;
    } | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (reapTimer) clearTimeout(reapTimer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (outcome?.error) {
        reject(outcome.error);
      } else {
        resolve(outcome?.value || '');
      }
    };
    const finish = (error?: unknown, value = output) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      outcome = {
        error,
        value
      };
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
        settle();
      } else {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (settled) return;
          child.kill('SIGKILL');
          reapTimer = setTimeout(() => {
            if (settled) return;
            console.warn('[ExternalRuntime] Probe cleanup unconfirmed after termination deadline', { pid: child.pid, issue: 'process-failed' });
            outcome = { error: outcome?.error ?? new RuntimeError('process-failed') };
            child.unref();
            settle();
          }, 1000);
          reapTimer.unref();
        }, 1000);
        killTimer.unref();
      }
    };
    const timeout = setTimeout(() => finish(new RuntimeError('probe-timeout')), 20000);
    const abort = () => finish(abortError(signal));
    signal.addEventListener('abort', abort, {
      once: true
    });
    child.on('error', () => finish(new RuntimeError('process-failed')));
    child.on('exit', () => {
      if (done) {
        settle();
      }
    });
    child.stdin.on('error', () => {
      if (!done) {
        finish(new RuntimeError('process-failed'));
      }
    });
    child.on('close', code => {
      if (done) {
        settle();
      } else {
        finish(code === 0 && !request.onLine ? undefined : new RuntimeError('process-failed'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        finish(new RuntimeError('process-failed'));
      }
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) {
        return;
      }
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        finish(new RuntimeError('process-failed'));
        return;
      }
      if (!request.onLine) {
        output += chunk.toString('utf8');
        return;
      }
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1 && !done) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          if (request.onLine(line, message => child.stdin.write(message))) {
            finish(undefined, 'ready');
          }
        } catch (error) {
          finish(error);
        }
      }
    });
    if (request.input) {
      child.stdin.write(request.input);
    }
    if (!request.onLine) {
      child.stdin.end();
    }
  });
}
export function createRuntimeProbe(provider: RuntimeProvider) {
  const cache = new Map<string, {
    stamp: string;
    result: RuntimeInstallation;
    launch?: RuntimeLaunch;
    expires: number;
  }>();
  const checkedLaunches = new WeakMap<RuntimeInstallation, RuntimeLaunch>();
  const pending = new Map<string, Promise<RuntimeInstallation>>();
  const running = new Set<Promise<RuntimeInstallation>>();
  const shutdown = new AbortController();
  setMaxListeners(CAPACITY + 8, shutdown.signal);
  function put(key: string, entry: typeof cache extends Map<string, infer V> ? V : never) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CAPACITY) {
      cache.delete(cache.keys().next().value!);
    }
  }
  async function inspect(candidate: ResolvedCandidate, signal: AbortSignal): Promise<RuntimeInstallation> {
    const result: RuntimeInstallation = {
      path: candidate.path,
      resolvedPath: candidate.resolvedPath,
      kind: candidate.launch.kind,
      managed: await isManagedPath(provider, candidate.resolvedPath),
      compatibility: 'unavailable',
      recommended: false,
      checkedAt: new Date().toISOString()
    };
    let directory: string | undefined, release: (() => void) | undefined;
    try {
      release = await acquire(signal);
      directory = await mkdtemp(join(tmpdir(), `halo-${provider.directoryName}-probe-`));
      const run = Object.assign((request: ProbeProcess) => runProcess(candidate, directory!, request, signal), {
        directory,
        reportVersion(version: string) {
          result.version = version;
          result.recommended = provider.isRecommendedVersion(version);
        }
      }) as RuntimeProbeRunner;
      result.version = await provider.probe(candidate, run);
      result.recommended = provider.isRecommendedVersion(result.version);
      result.compatibility = provider.isVerifiedRuntime(result.version, candidate.launch.kind) ? 'verified' : 'compatible';
    } catch (error) {
      result.issue = issueFromError(error, 'process-failed');
      result.compatibility = ['version-too-old', 'version-unrecognized', 'protocol-unsupported'].includes(result.issue) ? 'incompatible' : 'unavailable';
      console.warn('[ExternalRuntime] Compatibility probe did not pass', {
        runtimeId: provider.id,
        kind: result.kind,
        version: result.version,
        issue: result.issue
      });
    } finally {
      if (directory) {
        await rm(directory, {
          recursive: true,
          force: true
        }).catch(error => console.warn('[ExternalRuntime] Probe cleanup failed', {
          runtimeId: provider.id,
          code: (error as NodeJS.ErrnoException).code
        }));
      }
      release?.();
    }
    return result;
  }
  async function checkInstallation(input: string, options: {
    force?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<RuntimeInstallation> {
    let candidate: ResolvedCandidate;
    try {
      candidate = await provider.resolveCandidate(input);
    } catch (error) {
      const issue = issueFromError(error, 'not-executable');
      console.warn('[ExternalRuntime] Installation could not be resolved', {
        runtimeId: provider.id,
        issue
      });
      let path = typeof input === 'string' ? input.slice(0, 4096) : '';
      try {
        path = normalizeInputPath(input);
      } catch {/* Resolution failure is reported above. */}
      const result: RuntimeInstallation = {
        path,
        compatibility: 'unavailable',
        recommended: false,
        managed: false,
        checkedAt: new Date().toISOString(),
        issue
      };
      put(path, {
        stamp: '',
        result,
        expires: Date.now() + 30000
      });
      return result;
    }
    const key = candidate.path,
      cached = cache.get(key);
    if (!options.force && cached?.stamp === candidate.stamp && cached.expires > Date.now()) {
      cache.delete(key);
      cache.set(key, cached);
      const result = { ...cached.result };
      if (cached.launch) checkedLaunches.set(result, cached.launch);
      return result;
    }
    const pendingKey = `${key}:${candidate.stamp}`;
    if (pending.has(pendingKey) && !options.signal) {
      return pending.get(pendingKey)!;
    }
    const signal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal;
    const work = inspect(candidate, signal).then(result => {
      const usable = ['verified', 'compatible'].includes(result.compatibility);
      const launch = usable ? { ...candidate.launch, version: result.version! } : undefined;
      put(key, {
        stamp: candidate.stamp,
        result,
        launch,
        expires: usable ? Infinity : Date.now() + 30000
      });
      const checked = { ...result };
      if (launch) checkedLaunches.set(checked, launch);
      return checked;
    }).finally(() => {
      if (pending.get(pendingKey) === work) {
        pending.delete(pendingKey);
      }
      running.delete(work);
    });
    running.add(work);
    if (!options.signal) {
      pending.set(pendingKey, work);
    }
    return work;
  }
  async function launchForInstallation(path: string, options: {
    signal?: AbortSignal;
  } = {}): Promise<RuntimeLaunch | null> {
    const result = await checkInstallation(path, options);
    if (!['verified', 'compatible'].includes(result.compatibility)) {
      return null;
    }
    const launch = checkedLaunches.get(result);
    return launch ? {
      ...launch,
      argsPrefix: [...launch.argsPrefix],
      env: {
        ...launch.env
      },
      ...(launch.pathDirs ? {
        pathDirs: [...launch.pathDirs]
      } : {})
    } : null;
  }
  return {
    checkInstallation,
    launchForInstallation,
    readKnownInstallation(path: string) {
      const result = cache.get(path)?.result;
      return result ? {
        ...result
      } : null;
    },
    async shutdownProbes() {
      shutdown.abort();
      await Promise.allSettled([...running]);
      cache.clear();
    }
  };
}
