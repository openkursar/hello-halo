// ============================================================================
// dsh engine runtime bundle — build-tooling source of truth
//
// dsh ships as ~400 unbundled npm packages. Halo runs it as a plain Node child
// process, and a plain Node process has no asar support, so shipping the tree
// as-is meant unpacking 30k loose files next to the archive. On Windows that
// dominates install time: NTFS charges per file creation and Defender scans
// each one.
//
// The tree is bundled into a single file instead. This is possible because the
// cordis composition names a CLOSED set of plugins — `cordis-config.ts` holds
// them as literal YAML — so every module the engine can reach is known at build
// time. The generated entry imports them statically and registers them in the
// Loader's `builtins` map, which `cordis:`-prefixed plugin names resolve
// through without touching disk (cordis-plugin-loader `EntryTree#import`).
//
// Shared by runtimes/dsh/build.mjs (which builds it), electron-builder.cjs
// (which unpacks it) and scripts/afterPack.cjs (which verifies it), so the three
// cannot disagree about what "the dsh runtime" is.
// ============================================================================

const path = require('path');

/**
 * Where the engine's npm packages are installed, relative to the project root:
 * a package of its own (`package.json` + lock), so nothing dsh needs enters the
 * app's dependency graph. Same shape as runtimes/office/.
 */
const SOURCE_DIR = 'runtimes/dsh';

/** Bundle root, relative to the project root and to the packaged app root. */
const RUNTIME_DIR = 'resources/dsh-runtime';

/**
 * Bundle entry, relative to {@link RUNTIME_DIR}.
 *
 * The `lib/` level is not cosmetic. Three dsh packages read their own version
 * at module scope via `createRequire(import.meta.url)('../package.json')`
 * (dsh-llm, dsh-repeat-tool-reminder, dsh-session-telemetry-otel). Bundling
 * rewrites `import.meta.url` to the bundle's location, so that relative path
 * has to keep resolving — it lands on the manifest this directory sits under.
 */
const RUNTIME_ENTRY = 'lib/runtime.mjs';

/**
 * Every plugin a composition can mount, as npm package names.
 *
 * Must stay a superset of the names `cordis-config.ts` and `mcp-plugins.ts`
 * emit: a plugin missing here is absent from the bundle, and the Loader then
 * falls through to a real `import()` that cannot resolve inside the packaged
 * app. `tests/unit/services/agent/dsh/runtime-manifest.test.ts` asserts the
 * relation rather than leaving it to review.
 */
const PLUGIN_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-image-offload',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek-api-key',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-terminal',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-fetch-http',
  '@deepseek-ai/dsh-web-search-deepseek',
];

/**
 * Plugins Halo writes itself, compiled into the same bundle and registered as
 * builtins under `id` (so a composition names them `cordis:<id>`). `source` is
 * relative to the project root.
 */
const HALO_PLUGINS = [
  { id: 'halo-assistant-stream', source: 'runtimes/dsh/plugins/assistant-stream.ts' },
];

/** The boot helper the generated entry drives the Loader through. */
const BOOT_PACKAGE = '@deepseek-ai/dsh-app-boot';

/**
 * Packages left out of the bundle and resolved from disk at runtime.
 *
 * A bundler can inline JavaScript but not a `.node` addon or a vendored
 * executable, both of which are opened by path. Each stays an ordinary npm
 * package so its own path logic keeps working; the bundle imports them by bare
 * name and Node's resolution finds them in `RUNTIME_DIR/node_modules` — every
 * one is a private external, never the app's copy.
 *
 * dsh also loads some packages through its lazy-require helper, which no
 * bundler can follow (`@xterm/headless` is pure JS yet lands here for that
 * reason). build.mjs fails when such a name is missing below.
 */
const EXTERNAL_PACKAGES = [
  'node-pty',
  'koffi',
  '@vscode/ripgrep',
  '@xterm/headless',
  'sharp',
];

/**
 * Where each external comes from: copied beside the bundle from where `from`
 * resolves it in `SOURCE_DIR`, together with its production dependencies. The
 * runtime therefore never leans on the app's packages — several would be the
 * wrong version anyway (Halo's terminal is on node-pty 1.1.0 and
 * @xterm/headless 5; dsh pins the node-pty 1.2.0 beta and needs
 * @xterm/headless 6).
 */
const PRIVATE_EXTERNALS = [
  { name: 'node-pty', from: '@deepseek-ai/dsh-subprocess-local' },
  { name: '@xterm/headless', from: '@deepseek-ai/dsh-terminal-bash' },
  { name: 'sharp', from: '@deepseek-ai/dsh-attachment-local' },
  { name: 'koffi', from: '@deepseek-ai/dsh-subprocess-local' },
  { name: '@vscode/ripgrep', from: '@deepseek-ai/dsh-tool-fs-search' },
];

/**
 * Per-platform native packages beside the bundle, keyed by the
 * `${process.platform}-${process.arch}` of the machine that will load them.
 * `loader` is the package that opens them by path and pins their versions in
 * its `optionalDependencies`; it resolves them from `RUNTIME_DIR/node_modules`.
 * npm installs only the host's variants, so build.mjs plants every
 * variant and afterPack.cjs keeps the target's alone.
 *
 * - `@deepseek-ai/node-addon-system` carries the Landlock launcher
 *   dsh-sandbox-local falls back to on Linux when bwrap is unusable; without it
 *   the sandbox fails closed. macOS (Seatbelt) and Windows (ACLs) need none.
 * - `sharp` normalizes every image the attachment store admits; without its
 *   binary and libvips an image prompt fails.
 * - `koffi` is the FFI the dsh packages call Win32 through (process control,
 *   Windows sandbox ACLs); it throws at load without its binary.
 * - `@vscode/ripgrep` is the search binary behind glob and grep, resolved at
 *   the first search call — a missing one fails every search.
 */
const NATIVE_COMPANIONS = [
  {
    loader: '@deepseek-ai/node-addon-system',
    packages: {
      'linux-x64': ['@deepseek-ai/node-addon-system-linux-x64'],
      'linux-arm64': ['@deepseek-ai/node-addon-system-linux-arm64'],
    },
  },
  {
    loader: 'sharp',
    packages: {
      'darwin-arm64': ['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64'],
      'darwin-x64': ['@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64'],
      'linux-x64': ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'],
      'linux-arm64': ['@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64'],
      'win32-x64': ['@img/sharp-win32-x64'],
    },
  },
  {
    loader: 'koffi',
    packages: {
      'darwin-arm64': ['@koromix/koffi-darwin-arm64'],
      'darwin-x64': ['@koromix/koffi-darwin-x64'],
      'linux-x64': ['@koromix/koffi-linux-x64'],
      'linux-arm64': ['@koromix/koffi-linux-arm64'],
      'win32-x64': ['@koromix/koffi-win32-x64'],
    },
  },
  {
    loader: '@vscode/ripgrep',
    packages: {
      'darwin-arm64': ['@vscode/ripgrep-darwin-arm64'],
      'darwin-x64': ['@vscode/ripgrep-darwin-x64'],
      'linux-x64': ['@vscode/ripgrep-linux-x64'],
      'linux-arm64': ['@vscode/ripgrep-linux-arm64'],
      'win32-x64': ['@vscode/ripgrep-win32-x64'],
    },
  },
];

/** Platform keys a Halo build can target. */
const TARGET_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];

/** Every native companion, for any platform. */
function allNativeCompanions() {
  return NATIVE_COMPANIONS.flatMap(({ packages }) => Object.values(packages).flat());
}

/** The native companions one target platform keeps. */
function nativeCompanionsFor(key) {
  return NATIVE_COMPANIONS.flatMap(({ packages }) => packages[key] || []);
}

/** Absolute bundle entry inside `root` (a project root or a packaged app root). */
function runtimeEntryPath(root) {
  return path.join(root, ...RUNTIME_DIR.split('/'), ...RUNTIME_ENTRY.split('/'));
}

/** asarUnpack pattern covering the bundle and its private externals. */
function runtimeAsarUnpackGlob() {
  return `${RUNTIME_DIR}/**/*`;
}

module.exports = {
  SOURCE_DIR,
  RUNTIME_DIR,
  RUNTIME_ENTRY,
  PLUGIN_PACKAGES,
  HALO_PLUGINS,
  BOOT_PACKAGE,
  EXTERNAL_PACKAGES,
  PRIVATE_EXTERNALS,
  NATIVE_COMPANIONS,
  TARGET_PLATFORMS,
  allNativeCompanions,
  nativeCompanionsFor,
  runtimeEntryPath,
  runtimeAsarUnpackGlob,
};
