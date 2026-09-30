// ============================================================================
// Agent SDK engine runtimes — build-tooling source of truth
//
// Which npm package carries each engine, and how to find its entry file.
// Shared by the pre-package checker (tests/check/binaries.mjs) and the
// post-package assertion (scripts/afterPack.cjs) so the two can never disagree
// about what "the halo engine shipped" means.
//
// The runtime has its own copy of this knowledge in
// src/main/services/agent/engine-availability.ts: it runs inside the bundled
// main process and cannot require a build script. Keep them in step.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { RUNTIME_DIR, RUNTIME_ENTRY } = require('../runtimes/dsh/manifest.cjs');

const ENGINE_RUNTIMES = {
  anthropic: {
    name: 'Claude Code SDK engine',
    packageId: '@anthropic-ai/claude-agent-sdk',
    fix: 'npm install',
  },
  // Optional `file:` dependency whose source directory is gitignored. npm skips
  // it without failing when that directory is empty, which ships a package with
  // no halo engine — the failure this table exists to make visible.
  halo: {
    name: 'Halo SDK engine',
    packageId: '@hello-halo/agent-sdk',
    fix: 'populate src/sdk/halo-sdk (local path dependency), then run npm install',
  },
  codex: {
    name: 'Codex SDK engine',
    packageId: '@openai/codex-sdk',
    fix: 'npm install',
  },
  // The only engine that is not an npm package in the artifact: it is compiled
  // into one file by runtimes/dsh/build.mjs, and the package tree it was
  // built from is excluded from packaging. Naming a `packageId` here would make
  // every check look for something the artifact deliberately does not carry.
  dsh: {
    name: 'DeepSeek Harness engine',
    prebuilt: { dir: RUNTIME_DIR, entry: RUNTIME_ENTRY },
    fix: 'node runtimes/dsh/build.mjs',
  },
};

const VALID_ENGINES = Object.keys(ENGINE_RUNTIMES);

/**
 * Entry file candidates declared by a package manifest, most specific first.
 * Callers resolve them against whichever filesystem they are inspecting
 * (real directory, or an asar listing).
 */
function entryCandidates(manifest) {
  const candidates = [];

  const root = manifest.exports && manifest.exports['.'];
  if (typeof root === 'string') {
    candidates.push(root);
  } else if (root && typeof root === 'object') {
    for (const condition of ['import', 'module', 'default', 'require', 'node']) {
      if (typeof root[condition] === 'string') candidates.push(root[condition]);
    }
  }

  for (const field of ['main', 'module']) {
    if (typeof manifest[field] === 'string') candidates.push(manifest[field]);
  }
  candidates.push('index.js');

  return candidates;
}

/**
 * Resolve an engine entry inside a real directory.
 * Returns null when the package has no loadable entry — the shape a broken
 * local dependency produces, which must be treated as "engine absent".
 */
function resolveEngineEntry(pkgDir, manifest) {
  for (const candidate of entryCandidates(manifest)) {
    const resolved = path.join(pkgDir, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

/**
 * Where an engine's identity lives, relative to whatever root the caller is
 * inspecting: the artifact, or the project's node_modules.
 *
 * Both shapes answer the same two questions — which file to fingerprint, and
 * which manifest carries the version — so callers can treat them uniformly
 * instead of branching on how the engine happens to be delivered.
 */
function engineArtifactPaths(engine) {
  if (engine.prebuilt) {
    return {
      manifestPath: path.join(engine.prebuilt.dir, 'package.json'),
      entryPaths: [path.join(engine.prebuilt.dir, ...engine.prebuilt.entry.split('/'))],
      label: `${engine.prebuilt.dir}/${engine.prebuilt.entry}`,
    };
  }

  const pkgDir = path.join('node_modules', ...engine.packageId.split('/'));
  return { pkgDir, manifestPath: path.join(pkgDir, 'package.json'), label: engine.packageId };
}

module.exports = {
  ENGINE_RUNTIMES,
  VALID_ENGINES,
  entryCandidates,
  resolveEngineEntry,
  engineArtifactPaths,
};
