import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { RuntimeDownloadSource, RuntimeInstallation, RuntimeInstallProgress } from '../../../shared/types/external-runtime';
import type { RuntimeCatalog } from './catalog';
import { RuntimeError, issueFromError } from './errors';
import { getRuntimeRoot } from './paths';
import type { RuntimeArtifact, RuntimeProvider } from './provider';
import type { createRuntimeProbe } from './probe';
import type { createRuntimeReleases } from './releases';
import type { createRuntimeReuse } from './reuse';
import { isInstallVersion, validateSource, VERSION_PATTERN } from './sources';
import { MAX_BINARY_BYTES, responseBody, transferAbortError, validateTransferUrl } from './transfer';
function digestFor(artifact: RuntimeArtifact): {
  algorithm: string;
  expected: Buffer;
} {
  if (!artifact.integrity) {
    if (!/^[a-f0-9]{64}$/i.test(artifact.checksum)) {
      throw new RuntimeError('invalid-manifest');
    }
    return {
      algorithm: 'sha256',
      expected: Buffer.from(artifact.checksum, 'hex')
    };
  }
  const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(artifact.integrity);
  if (!match) {
    throw new RuntimeError('invalid-manifest');
  }
  const expected = Buffer.from(match[2], 'base64');
  if (expected.length !== {
    sha512: 64,
    sha384: 48,
    sha256: 32
  }[match[1]]) {
    throw new RuntimeError('invalid-manifest');
  }
  return {
    algorithm: match[1],
    expected
  };
}
async function downloadArtifact(artifact: RuntimeArtifact, destination: string, signal: AbortSignal, progress: (value: RuntimeInstallProgress) => void): Promise<void> {
  const response = await responseBody(artifact.url, signal);
  const length = Number(response.headers.get('content-length')),
    totalBytes = artifact.size || (Number.isFinite(length) && length > 0 ? length : undefined);
  if (totalBytes && totalBytes > MAX_BINARY_BYTES) {
    await response.body!.cancel();
    throw new RuntimeError('invalid-manifest');
  }
  const reader = response.body!.getReader(),
    digest = digestFor(artifact),
    hash = createHash(digest.algorithm);
  let file: Awaited<ReturnType<typeof open>> | undefined,
    downloadedBytes = 0,
    lastReport = 0,
    failure: unknown;
  try {
    file = await open(destination, 'wx', 0o600);
    while (true) {
      signal.throwIfAborted();
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (cause) {
        throw new RuntimeError(signal.aborted ? 'cancelled' : 'download-failed', {
          cause
        });
      }
      if (next.done) {
        break;
      }
      downloadedBytes += next.value.length;
      if (downloadedBytes > MAX_BINARY_BYTES || artifact.size && downloadedBytes > artifact.size) {
        throw new RuntimeError('checksum-mismatch');
      }
      hash.update(next.value);
      await file.writeFile(next.value);
      if (Date.now() - lastReport >= 250) {
        progress({
          phase: 'downloading',
          version: artifact.version,
          downloadedBytes,
          totalBytes
        });
        lastReport = Date.now();
      }
    }
    signal.throwIfAborted();
    progress({
      phase: 'verifying',
      version: artifact.version,
      downloadedBytes,
      totalBytes
    });
    const actual = hash.digest();
    if (artifact.size && downloadedBytes !== artifact.size || actual.length !== digest.expected.length || !timingSafeEqual(actual, digest.expected)) {
      throw new RuntimeError('checksum-mismatch');
    }
    await file.sync();
  } catch (error) {
    failure = error instanceof RuntimeError ? error.cause ?? error : error;
    throw error;
  } finally {
    await file?.close();
    await reader.cancel().catch(error => {
      if (error !== failure) {
        console.warn('[ExternalRuntime] Download stream cleanup failed', {
          name: (error as Error).name
        });
      }
    });
  }
}
export function createRuntimeInstaller(provider: RuntimeProvider, catalog: RuntimeCatalog, probe: ReturnType<typeof createRuntimeProbe>, releases: ReturnType<typeof createRuntimeReleases>, reuse: ReturnType<typeof createRuntimeReuse>) {
  async function downloadAndPublish(sourceInput: RuntimeDownloadSource, requestedVersion: string, signal: AbortSignal, progress: (value: RuntimeInstallProgress) => void): Promise<RuntimeInstallation> {
    const source = validateSource(sourceInput);
    if (!isInstallVersion(requestedVersion)) {
      throw new RuntimeError('invalid-version');
    }
    const platform = provider.getPlatform(),
      controller = new AbortController(),
      abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, {
      once: true
    });
    if (signal.aborted) {
      abort();
    }
    const timeout = setTimeout(() => controller.abort(new RuntimeError('source-timeout')), 10 * 60000);
    let staging: string | undefined;
    try {
      progress({
        phase: 'checking',
        downloadedBytes: 0,
        version: requestedVersion
      });
      if (VERSION_PATTERN.test(requestedVersion)) {
        const reused = await reuse.reuseManagedInstallation(requestedVersion, platform, controller.signal, {
          sourceUrl: source.baseUrl,
          artifactIntegrity: provider.pinnedIntegrity?.(requestedVersion, platform),
          requireSourceMatch: true
        });
        if (reused) {
          return reused;
        }
      }
      progress({
        phase: 'manifest',
        downloadedBytes: 0
      });
      const artifact = await releases.lookupRelease(source, requestedVersion, {
        signal: controller.signal
      });
      validateTransferUrl(artifact.url, new URL(source.baseUrl).protocol === 'https:');
      const reused = await reuse.reuseManagedInstallation(artifact.version, platform, controller.signal, {
        ...(artifact.integrity ? {
          artifactIntegrity: artifact.integrity
        } : {
          checksum: artifact.checksum
        }),
        sourceUrl: source.baseUrl
      });
      if (reused) {
        return reused;
      }
      const root = getRuntimeRoot(provider);
      await mkdir(root, {
        recursive: true
      });
      staging = join(root, `.install-${randomUUID()}`);
      await mkdir(staging, {
        mode: 0o700
      });
      const archive = join(staging, '.artifact');
      await downloadArtifact(artifact, archive, controller.signal, progress);
      const materialized = await provider.materialize(artifact, archive, staging, controller.signal);
      await rm(archive, {
        force: true
      });
      const path = join(staging, materialized.executable),
        local = relative(staging, path);
      if (isAbsolute(materialized.executable) || !local || local === '..' || local.startsWith(`..${sep}`)) {
        throw new RuntimeError('invalid-manifest');
      }
      progress({
        phase: 'checking',
        version: artifact.version,
        downloadedBytes: artifact.size || 0,
        totalBytes: artifact.size
      });
      const result = await probe.checkInstallation(path, {
        force: true,
        signal: controller.signal
      });
      if (result.kind !== 'native' || !['verified', 'compatible'].includes(result.compatibility)) {
        throw new RuntimeError(result.issue || 'protocol-unsupported');
      }
      if (result.version !== artifact.version) {
        throw new RuntimeError('version-mismatch');
      }
      if (controller.signal.aborted) {
        throw transferAbortError(controller.signal);
      }
      let published = join(root, `${artifact.version}-${platform}-${artifact.checksum.slice(0, 16)}`);
      try {
        await rename(staging, published);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) {
          throw error;
        }
        published = `${published}-${randomUUID()}`;
        await rename(staging, published);
        console.warn('[ExternalRuntime] Published fresh copy preserving existing runtime', {
          runtimeId: provider.id,
          version: artifact.version,
          platform
        });
      }
      staging = undefined;
      const installed: RuntimeInstallation = {
        ...result,
        path: join(published, materialized.executable),
        resolvedPath: join(published, materialized.executable),
        managed: true,
        sourceId: source.id,
        installedAt: new Date().toISOString()
      };
      await catalog.rememberInstallation(installed, {
        platform,
        sourceUrl: source.baseUrl,
        ...(artifact.integrity ? {
          artifactIntegrity: artifact.integrity,
          directory: published,
          components: materialized.components
        } : {
          checksum: artifact.checksum
        })
      });
      return installed;
    } catch (error) {
      if (controller.signal.aborted) {
        throw transferAbortError(controller.signal);
      }
      throw new RuntimeError(issueFromError(error, 'storage-failed'), {
        cause: error
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (staging) {
        await rm(staging, {
          recursive: true,
          force: true
        }).catch(error => console.warn('[ExternalRuntime] Staging cleanup failed', {
          runtimeId: provider.id,
          code: (error as NodeJS.ErrnoException).code
        }));
      }
    }
  }
  return {
    downloadAndPublish
  };
}
