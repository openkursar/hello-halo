import { getConfig, saveConfig } from '../../foundation/config.service';
import { DEFAULT_MAX_TURNS } from '../../../shared/constants/agent-limits';
import type { RuntimeConfig, RuntimeInstallation, RuntimeInstallProgress, RuntimeInstallRequest, RuntimePreferences, RuntimeStatus } from '../../../shared/types/external-runtime';
import { createRuntimeCatalog, hasRequiredIntegrity, mergeInstallationSnapshot } from './catalog';
import { createRuntimeDiscovery } from './discovery';
import { RuntimeError, issueFromError } from './errors';
import { createRuntimeInstaller } from './installer';
import { getRuntimeRoot } from './paths';
import { createRuntimeProbe } from './probe';
import type { RuntimeProvider } from './provider';
import { createRuntimeReleases } from './releases';
import { createRuntimeReuse } from './reuse';
import { createRuntimeSources, isInstallVersion } from './sources';
export function createExternalRuntime(provider: RuntimeProvider) {
  let installController: AbortController | undefined, installFinished: Promise<void> | undefined;
  let installProgress: RuntimeInstallProgress = {
      phase: 'idle',
      downloadedBytes: 0
    },
    selectionRevision = 0;
  const validatedLaunches = new Map<string, string>();
  const readConfig = (): RuntimeConfig => getConfig().agent?.[provider.configKey] || {};
  function persistConfig(patch: Partial<RuntimeConfig>) {
    const next = {
        ...readConfig(),
        ...patch
      },
      agent = getConfig().agent;
    saveConfig({
      agent: {
        ...agent,
        maxTurns: agent?.maxTurns ?? DEFAULT_MAX_TURNS,
        [provider.configKey]: next
      }
    });
    if (JSON.stringify(readConfig()) !== JSON.stringify(next)) {
      throw new RuntimeError('storage-failed');
    }
  }
  const catalog = createRuntimeCatalog(provider, readConfig, () => getRuntimeRoot(provider));
  const probe = createRuntimeProbe(provider),
    releases = createRuntimeReleases(provider),
    sources = createRuntimeSources(provider);
  const reuse = createRuntimeReuse(provider, catalog, probe),
    installer = createRuntimeInstaller(provider, catalog, probe, releases, reuse),
    discovery = createRuntimeDiscovery(provider, probe);
  async function getStatus(): Promise<RuntimeStatus> {
    const config = readConfig(),
      selectedPath = provider.hasExplicitSelection?.(config) ?? Boolean(config.selectedPath) ? config.selectedPath : undefined;
    const snapshot = await catalog.getCatalogSnapshot();
    const installations = snapshot.installations.map(item => {
      if (provider.requiredComponents && item.managed && item.issue === 'checksum-mismatch') return item;
      const known = probe.readKnownInstallation(item.path);
      return known?.checkedAt && (!item.checkedAt || known.checkedAt > item.checkedAt) ? mergeInstallationSnapshot(item, known) : item;
    });
    return {
      selectedPath,
      selected: selectedPath ? installations.find(item => item.path === selectedPath) ?? probe.readKnownInstallation(selectedPath) : null,
      installations,
      catalogTruncated: snapshot.truncated,
      sources: sources.getSources(config),
      sourceId: sources.getEffectiveSourceId(config),
      installVersion: config.installVersion || provider.recommendedVersion,
      recommendedVersion: provider.recommendedVersion,
      recommendedRange: provider.recommendedRange,
      verifiedVersions: provider.verifiedVersions(),
      install: {
        ...installProgress
      }
    };
  }
  function savePreferences(preferences: RuntimePreferences) {
    const current = readConfig();
    persistConfig(sources.validatePreferences({
      sources: current.sources,
      sourceId: current.sourceId,
      installVersion: current.installVersion,
      ...preferences
    }));
  }
  async function configure(preferences: RuntimePreferences) {
    try {
      savePreferences(preferences);
      return await getStatus();
    } catch (error) {
      console.warn('[ExternalRuntime] Preferences could not be saved', {
        runtimeId: provider.id,
        issue: issueFromError(error, 'storage-failed')
      });
      throw error;
    }
  }
  async function probeInstallation(path: string) {
    const entry = await catalog.getCatalogEntry(path);
    if (entry?.installation.managed && provider.requiredComponents && !hasRequiredIntegrity(provider, entry)) {
      console.warn('[ExternalRuntime] Managed installation check refused incomplete integrity', { runtimeId: provider.id });
      return { ...entry.installation, compatibility: 'unavailable' as const, issue: 'checksum-mismatch' as const };
    }
    const result = await probe.checkInstallation(path, {
      force: true
    });
    if (['verified', 'compatible'].includes(result.compatibility) || (await catalog.getCatalogSnapshot()).installations.some(item => item.path === result.path)) {
      await catalog.rememberInstallation(result);
    }
    return result;
  }
  async function lookup(request: RuntimeInstallRequest = {}) {
    const config = readConfig(),
      source = sources.getSources(config).find(item => item.id === (request.sourceId || sources.getEffectiveSourceId(config)));
    if (!source) {
      throw new RuntimeError('invalid-source');
    }
    try {
      const release = await releases.lookupRelease(source, request.version ?? config.installVersion ?? provider.recommendedVersion);
      const installed = (await catalog.getManagedCatalogEntries(release.version, release.platform)).find(entry => !['unavailable', 'incompatible'].includes(entry.installation.compatibility) && (release.integrity ? entry.integrity?.artifactIntegrity === release.integrity : entry.integrity?.checksum === release.checksum));
      const {
        url: _url,
        integrity: _integrity,
        payloadVersion: _payloadVersion,
        ...info
      } = release;
      return {
        ...info,
        ...(installed ? {
          installedPath: installed.installation.path
        } : {})
      };
    } catch (error) {
      console.warn('[ExternalRuntime] Release lookup did not complete', {
        runtimeId: provider.id,
        sourceId: source.id,
        issue: issueFromError(error, 'source-unreachable')
      });
      throw error;
    }
  }
  async function persistSelection(result: RuntimeInstallation, revision: number): Promise<boolean> {
    await catalog.rememberInstallation(result);
    if (revision !== selectionRevision) {
      console.log('[ExternalRuntime] Preserved newer runtime choice', {
        runtimeId: provider.id
      });
      return false;
    }
    try {
      persistConfig({
        selectedPath: result.path,
        selectionOrigin: 'user'
      });
    } catch (error) {
      console.error('[ExternalRuntime] Checked runtime could not be selected', {
        runtimeId: provider.id,
        issue: 'storage-failed'
      });
      throw new RuntimeError('storage-failed', {
        cause: error
      });
    }
    console.log('[ExternalRuntime] Runtime selected', {
      runtimeId: provider.id,
      version: result.version,
      kind: result.kind,
      managed: result.managed
    });
    return true;
  }
  async function select(path: string) {
    const revision = ++selectionRevision;
    const entry = await catalog.getCatalogEntry(path);
    if (entry?.installation.managed && provider.requiredComponents && !hasRequiredIntegrity(provider, entry)) {
      console.warn('[ExternalRuntime] Managed installation selection refused incomplete integrity', { runtimeId: provider.id });
      throw new RuntimeError('checksum-mismatch');
    }
    let result: RuntimeInstallation;
    if (entry?.integrity && entry.installation.version) {
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(new RuntimeError('probe-timeout')), 30000);
      try {
        const reused = await reuse.reuseManagedInstallation(entry.installation.version, entry.integrity.platform, controller.signal, {
          path
        });
        if (!reused) {
          throw new RuntimeError((await catalog.getCatalogEntry(path))?.installation.issue || 'not-executable');
        }
        result = reused;
      } finally {
        clearTimeout(timeout);
      }
    } else {
      result = await probe.checkInstallation(path);
    }
    if (!['verified', 'compatible'].includes(result.compatibility)) {
      if (entry) {
        await catalog.rememberInstallation({
          ...entry.installation,
          ...result,
          managed: entry.installation.managed
        });
      }
      throw new RuntimeError(result.issue || 'protocol-unsupported');
    }
    await persistSelection(result, revision);
    return result;
  }
  async function resolveLaunch(options: {
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {}) {
    const path = readConfig().selectedPath;
    if (!path) {
      return null;
    }
    const controller = new AbortController(),
      abort = () => controller.abort(new RuntimeError('cancelled'));
    options.signal?.addEventListener('abort', abort, {
      once: true
    });
    if (options.signal?.aborted) {
      abort();
    }
    const timeout = setTimeout(() => controller.abort(new RuntimeError('probe-timeout')), options.deadlineMs ?? 8000);
    let stopped: (() => void) | undefined;
    const checkedLaunch = async () => {
      try {
        const entry = await catalog.getCatalogEntry(path);
        if (controller.signal.aborted) {
          return null;
        }
        if (entry?.installation.managed && provider.requiredComponents && !hasRequiredIntegrity(provider, entry)) {
          console.warn('[ExternalRuntime] Managed installation launch refused incomplete integrity', { runtimeId: provider.id });
          return null;
        }
        if (entry?.integrity && entry.installation.version) {
          const candidate = await provider.resolveCandidate(path);
          if (controller.signal.aborted) {
            return null;
          }
          if (validatedLaunches.get(path) !== candidate.stamp) {
            const reused = await reuse.reuseManagedInstallation(entry.installation.version, entry.integrity.platform, controller.signal, {
              path
            });
            if (!reused || controller.signal.aborted) {
              return null;
            }
            validatedLaunches.delete(path);
            validatedLaunches.set(path, candidate.stamp);
            while (validatedLaunches.size > 24) {
              validatedLaunches.delete(validatedLaunches.keys().next().value!);
            }
          }
        }
        return await probe.launchForInstallation(path, {
          signal: controller.signal
        });
      } catch (error) {
        console.warn('[ExternalRuntime] Selected runtime integrity check failed', {
          runtimeId: provider.id,
          issue: issueFromError(error, 'not-executable')
        });
        return null;
      }
    };
    try {
      return await Promise.race([checkedLaunch().then(result => controller.signal.aborted ? null : result), new Promise<null>(resolve => {
        stopped = () => {
          console.warn('[ExternalRuntime] Selected runtime check stopped', {
            runtimeId: provider.id,
            issue: issueFromError(controller.signal.reason, 'cancelled')
          });
          resolve(null);
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
  async function install(request: RuntimeInstallRequest = {}) {
    if (installController) {
      throw new RuntimeError('install-busy');
    }
    const revision = ++selectionRevision;
    if (request.preferences) {
      savePreferences(request.preferences);
    }
    const config = readConfig(),
      source = sources.getSources(config).find(item => item.id === (request.sourceId || sources.getEffectiveSourceId(config)));
    if (!source) {
      throw new RuntimeError('invalid-source');
    }
    const version = request.version ?? config.installVersion ?? provider.recommendedVersion;
    if (!isInstallVersion(version)) {
      throw new RuntimeError('invalid-version');
    }
    const controller = new AbortController();
    let finish!: () => void;
    installFinished = new Promise<void>(resolve => {
      finish = resolve;
    });
    installController = controller;
    installProgress = {
      phase: 'manifest',
      downloadedBytes: 0
    };
    console.log('[ExternalRuntime] Managed installation started', {
      runtimeId: provider.id,
      sourceId: source.id,
      version
    });
    try {
      const result = await installer.downloadAndPublish(source, version, controller.signal, value => {
        installProgress = value;
      });
      if (controller.signal.aborted) {
        throw new RuntimeError('cancelled');
      }
      const checked = await probe.checkInstallation(result.path, {
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        throw new RuntimeError('cancelled');
      }
      if (!['verified', 'compatible'].includes(checked.compatibility)) {
        throw new RuntimeError(checked.issue || 'protocol-unsupported');
      }
      await persistSelection(checked, revision);
      installProgress = {
        ...installProgress,
        phase: 'complete',
        version: checked.version
      };
      console.log('[ExternalRuntime] Managed installation completed', {
        runtimeId: provider.id,
        version: checked.version
      });
      return checked;
    } catch (error) {
      const issue = issueFromError(error, 'storage-failed'),
        stage = installProgress.phase;
      installProgress = {
        ...installProgress,
        phase: issue === 'cancelled' ? 'cancelled' : 'error',
        issue
      };
      console.warn('[ExternalRuntime] Managed installation did not complete', {
        runtimeId: provider.id,
        version,
        stage,
        issue
      });
      throw new RuntimeError(issue, {
        cause: error
      });
    } finally {
      installController = undefined;
      finish();
      installFinished = undefined;
    }
  }
  function cancel() {
    if (!installController) {
      return false;
    }
    installController.abort();
    console.log('[ExternalRuntime] Installation cancellation requested', {
      runtimeId: provider.id
    });
    return true;
  }
  async function shutdown() {
    cancel();
    releases.clearReleaseCache();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([probe.shutdownProbes(), installFinished]), new Promise<void>(resolve => {
        timeout = setTimeout(() => {
          console.warn('[ExternalRuntime] Shutdown cleanup exceeded deadline', {
            runtimeId: provider.id
          });
          resolve();
        }, 2000);
      })]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
  return {
    catalog,
    probe,
    reuse,
    releases,
    sources,
    installer,
    discovery,
    getStatus,
    configure,
    probeInstallation,
    lookup,
    select,
    resolveLaunch,
    install,
    cancel,
    shutdown,
    scan: () => discovery.discoverInstallations(readConfig().selectedPath, {
      deadlineMs: 12000
    })
  };
}
