import type { RuntimeDownloadSource } from '../../../shared/types/external-runtime';
import { RuntimeError } from './errors';
import type { RuntimeArtifact, RuntimeProvider } from './provider';
import { isInstallVersion, validateSource, VERSION_PATTERN } from './sources';
import { transferAbortError } from './transfer';
async function withSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    throw transferAbortError(signal);
  }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<T>((_resolve, reject) => {
      abort = () => reject(transferAbortError(signal));
      signal.addEventListener('abort', abort, {
        once: true
      });
    })]);
  } finally {
    if (abort) {
      signal.removeEventListener('abort', abort);
    }
  }
}
export function createRuntimeReleases(provider: RuntimeProvider) {
  const cache = new Map<string, {
    value: RuntimeArtifact;
    expires: number;
  }>();
  const pending = new Map<string, {
    value: Promise<RuntimeArtifact>;
    controller: AbortController;
  }>();
  async function lookupRelease(sourceInput: RuntimeDownloadSource, requestedVersion: string, options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<RuntimeArtifact> {
    const source = validateSource(sourceInput);
    if (!isInstallVersion(requestedVersion)) {
      throw new RuntimeError('invalid-version');
    }
    const platform = provider.getPlatform(),
      key = `${source.baseUrl}\0${requestedVersion}\0${platform}`;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
      cache.delete(key);
      cache.set(key, cached);
      return {
        ...cached.value,
        sourceId: source.id
      };
    }
    const existing = pending.get(key);
    if (existing) {
      return {
        ...(await withSignal(existing.value, options.signal)),
        sourceId: source.id
      };
    }
    if (pending.size >= 4) {
      throw new RuntimeError('probe-busy');
    }
    const controller = new AbortController(),
      abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, {
      once: true
    });
    if (options.signal?.aborted) {
      abort();
    }
    const timeout = setTimeout(() => controller.abort(new RuntimeError('source-timeout')), options.timeoutMs ?? 12000);
    const value = withSignal(provider.fetchRelease(source, requestedVersion, platform, controller.signal), controller.signal).then(result => {
      cache.delete(key);
      cache.set(key, {
        value: result,
        expires: Date.now() + (VERSION_PATTERN.test(requestedVersion) ? 60000 : 15000)
      });
      while (cache.size > 32) {
        cache.delete(cache.keys().next().value!);
      }
      return result;
    }).finally(() => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (pending.get(key)?.value === value) {
        pending.delete(key);
      }
    });
    pending.set(key, {
      value,
      controller
    });
    return value;
  }
  return {
    lookupRelease,
    clearReleaseCache() {
      for (const operation of pending.values()) {
        operation.controller.abort();
      }
      pending.clear();
      cache.clear();
    }
  };
}
