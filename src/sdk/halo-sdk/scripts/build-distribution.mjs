import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
export { acquireBuildLock, buildLockPath, lockName } from './build-lock.mjs';

export const stagingPrefix = '.dist-staging-';
export const previousPrefix = '.dist-previous-';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const distributionEntries = ['index.js', 'index.d.ts', 'native/index.js', 'native/binding.js',
  'native/build-info.json', 'worker/entry.js', 'runtime-manifest.json'];

function exportTargets(value, targets = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('./dist/')) targets.add(value.slice('./dist/'.length));
  } else if (Array.isArray(value)) {
    for (const item of value) exportTargets(item, targets);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) exportTargets(item, targets);
  }
  return targets;
}

function outputPath(directory, file) {
  if (typeof file !== 'string' || !file || file.includes('\\')) throw new Error(`Invalid SDK output path: ${file}`);
  const path = resolve(directory, file);
  const local = relative(resolve(directory), path);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || !path.startsWith(`${resolve(directory)}${sep}`)) {
    throw new Error(`SDK output path leaves the distribution: ${file}`);
  }
  return path;
}

function manifestPath(file) {
  if (typeof file !== 'string' || !file.startsWith('dist/')) throw new Error(`Invalid runtime manifest path: ${file}`);
  return file.slice('dist/'.length);
}

async function readableFile(directory, file) {
  const path = outputPath(directory, file);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return null;
    return path;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function nativeDistributionState(directory, { verifyArtifact = true, platform = `${process.platform}-${process.arch}` } = {}) {
  const missing = [];
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'native/build-info.json'), 'utf8'));
    if (manifest.implementation !== 'rust' || manifest.abiVersion !== 1 || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
      missing.push('native/build-info.json identity');
    } else {
      if (platform && !manifest.artifacts.some(item => item.platform === platform && typeof item.filename === 'string')) {
        missing.push(`native artifact for ${platform}`);
      }
      for (const artifact of manifest.artifacts) {
        if (!/^halo-sdk\.[a-z0-9-]+\.node$/.test(artifact.filename ?? '')) {
          missing.push('native artifact filename');
          continue;
        }
        const path = await readableFile(directory, `native/${artifact.filename}`);
        if (!path) missing.push(`native/${artifact.filename}`);
        else if (verifyArtifact && (typeof artifact.sha256 !== 'string' || digest(await readFile(path)) !== artifact.sha256)) {
          missing.push(`native/${artifact.filename} checksum`);
        }
      }
    }
    if (!await readableFile(directory, 'native/THIRD-PARTY-NOTICES.txt')) missing.push('native/THIRD-PARTY-NOTICES.txt');
  } catch (error) {
    missing.push(`native/build-info.json (${error.message})`);
  }
  return { complete: !missing.length, missing, reason: missing.length ? `SDK native distribution is incomplete: ${missing.join(', ')}` : undefined };
}

/** A distribution is publishable only when its declared entries and retained runtime closure are present. */
export async function distributionState(sdk, {
  directory = join(sdk, 'dist'), verifyArtifact = true, platform = `${process.platform}-${process.arch}`,
} = {}) {
  const missing = [];
  for (const file of distributionEntries) {
    if (!await readableFile(directory, file)) missing.push(file);
  }
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
  } catch (error) {
    return { complete: false, missing: ['package.json'], reason: `SDK package.json is unreadable: ${error.message}` };
  }
  for (const file of exportTargets([descriptor.exports, descriptor.main, descriptor.types, descriptor.imports])) {
    if (!await readableFile(directory, file)) missing.push(file);
  }
  missing.push(...(await nativeDistributionState(directory, { verifyArtifact, platform })).missing);
  if (await readableFile(directory, 'runtime-manifest.json')) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'runtime-manifest.json'), 'utf8'));
      if (manifest.version !== 1 || !Array.isArray(manifest.runtime) || !manifest.runtime.length ||
          !Array.isArray(manifest.assets) || !Array.isArray(manifest.declarations) || !Array.isArray(manifest.entryPoints)) {
        missing.push('runtime-manifest.json identity');
      } else {
        const runtime = new Set(manifest.runtime.map(item => item.path));
        for (const entry of manifest.entryPoints) {
          if (!runtime.has(entry)) missing.push(`${entry} runtime record`);
        }
        for (const record of [...manifest.runtime, ...manifest.declarations]) {
          const file = manifestPath(record.path);
          const path = await readableFile(directory, file);
          if (!path) missing.push(file);
          else if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || (await stat(path)).size !== record.bytes) {
            missing.push(`${file} size`);
          }
        }
        for (const asset of manifest.assets) {
          const file = manifestPath(asset);
          if (!await readableFile(directory, file)) missing.push(file);
        }
      }
    } catch (error) {
      missing.push(`runtime-manifest.json (${error.message})`);
    }
  }
  const unique = [...new Set(missing)];
  return {
    complete: unique.length === 0,
    missing: unique,
    reason: unique.length ? `SDK distribution is incomplete: ${unique.join(', ')}` : undefined,
  };
}

export async function assertDistributionComplete(sdk, options) {
  const state = await distributionState(sdk, options);
  if (!state.complete) throw new Error(state.reason);
  return state;
}

export async function createStagingDirectory(sdk) {
  return mkdtemp(join(sdk, stagingPrefix));
}

async function newestDirectory(sdk, prefix) {
  const candidates = [];
  for (const entry of await readdir(sdk, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    try {
      candidates.push({ path: join(sdk, entry.name), mtimeMs: (await stat(join(sdk, entry.name))).mtimeMs });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/** Recover a build interrupted between its two renames, then remove abandoned staging output. */
export async function prepareBuildWorkspace(sdk) {
  const dist = join(sdk, 'dist');
  const previous = await newestDirectory(sdk, previousPrefix);
  if (!existsSync(dist) && previous.length) {
    await rename(previous[0].path, dist);
    console.log('[halo-sdk] Restored the previous distribution after an interrupted publish');
  }
  for (const entry of await readdir(sdk, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(stagingPrefix) && !entry.name.startsWith(previousPrefix)) continue;
    await rm(join(sdk, entry.name), { recursive: true, force: true }).catch(error => {
      if (error.code !== 'ENOENT') console.warn(`[halo-sdk] Could not remove ${entry.name}: ${error.message}`);
    });
  }
}

/**
 * Publish a fully built staging directory. The previous dist remains available
 * until the final rename sequence, which is two synchronous filesystem calls.
 */
export async function publishDistribution(sdk, staging, { rename: replace = renameSync, nativeOnly = false } = {}) {
  if (nativeOnly) {
    const state = await nativeDistributionState(staging, { platform: null });
    if (!state.complete) throw new Error(state.reason);
  } else {
    await assertDistributionComplete(sdk, { directory: staging, platform: null });
  }
  const dist = join(sdk, 'dist');
  const previous = join(sdk, `${previousPrefix}${process.pid}-${randomUUID()}`);
  const hadDistribution = existsSync(dist);
  if (hadDistribution) {
    try {
      replace(dist, previous);
    } catch (error) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        throw new Error(`Cannot replace ${dist} because it is in use; close running Halo processes and retry. The previous distribution was not changed.`, { cause: error });
      }
      throw error;
    }
  }
  try {
    replace(staging, dist);
  } catch (error) {
    if (hadDistribution) {
      try {
        replace(previous, dist);
      } catch (restoreError) {
        throw new Error(`Publishing ${dist} failed and the previous distribution could not be restored from ${previous}: ${restoreError.message}`, { cause: error });
      }
    }
    throw new Error(`Publishing ${dist} failed: ${error.message}`, { cause: error });
  }
  if (hadDistribution) {
    await rm(previous, { recursive: true, force: true }).catch(error => {
      if (error.code !== 'ENOENT') console.warn(`[halo-sdk] Could not remove ${basename(previous)}: ${error.message}`);
    });
  }
  console.log(`[halo-sdk] Published ${basename(dist)} from ${basename(staging)}`);
  return { mode: 'rename' };
}
