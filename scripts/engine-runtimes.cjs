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

module.exports = { ENGINE_RUNTIMES, VALID_ENGINES, entryCandidates, resolveEngineEntry };
