/**
 * Ignore patterns for file watching and scanning.
 *
 * Watching and tree visibility use different rule sets:
 *
 *   0. TREE_HIDDEN_DIRS          tree only
 *   1. ALWAYS_IGNORE_DIRS        watching only (also enforced natively — CPP_LEVEL_IGNORE_DIRS)
 *   2. BASELINE_IGNORE_PATTERNS  both
 *   3. .gitignore                watching only — additive, project-specific
 *
 * Within each consumer the rule sets stack, they are not either/or.
 *
 * Duplicate rules are harmless (the `ignore` library deduplicates).
 * Sources: github/gitignore templates, each language's official .gitignore.
 */

// ─── Layer 0: tree visibility ────────────────────────────────────────────────
// VCS metadata, matching VS Code's default `files.exclude`.
// Display only — adding here never changes what the watcher sees.

export const TREE_HIDDEN_DIRS = [
  '.git',
  '.hg',
  '.svn',
  'CVS',
  '.bzr',
]

// ─── Layer 1: C++ level ──────────────────────────────────────────────────────
// VCS and app metadata directories. Excluded via @parcel/watcher's native
// `ignore` option — events from these paths never reach JavaScript.
// `.halo` is watcher-only: every chat turn writes into .halo/conversations,
// which would otherwise trigger a tree refresh per message. Consequence: .halo
// is visible in the tree but never auto-updates — it refreshes on window focus
// or manual reconcile only.

export const ALWAYS_IGNORE_DIRS = [
  ...TREE_HIDDEN_DIRS,
  '.halo',
]

// ─── Layer 1.5: C++ level safe directories ───────────────────────────────────
// These directories are universally safe to ignore at C++ level because they
// are NEVER user-authored content. Unlike 'bin', 'env', 'dist' which could be
// user directories, these are always dependency/cache/build directories.

export const CPP_LEVEL_IGNORE_DIRS = [
  // VCS (same as ALWAYS_IGNORE_DIRS)
  ...ALWAYS_IGNORE_DIRS,

  // JavaScript/TypeScript - dependency and cache directories
  'node_modules',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.parcel-cache',
  '.cache',

  // Python - cache directories (NOT 'env' or 'venv' - could be user dirs)
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',

  // Java/Kotlin - IDE and build cache
  '.gradle',
  '.idea',

  // Swift/iOS
  '.build',
  '.swiftpm',
  'DerivedData',
  'Pods',

  // C/C++
  '.ccache',
]

// ─── Layer 2: JS baseline ────────────────────────────────────────────────────
// Always applied regardless of whether .gitignore exists.
// These are directories that are never user-authored content — dependency
// caches, build artifacts, IDE indexes. A project's .gitignore may or may
// not list them (e.g. .idea is often in global gitignore, not project-level),
// so we always exclude them as a safety net.

export const BASELINE_IGNORE_PATTERNS = [
  // ── JavaScript / TypeScript ──
  'node_modules',
  '.next',
  '.nuxt',
  '.output',       // Nuxt 3
  '.turbo',
  '.parcel-cache',
  '.cache',

  // ── Python ──
  '__pycache__',
  '.venv',         // Standard Python virtual environment
  'venv',          // Common virtual environment name
  // NOTE: 'env' removed - too generic, could be user config directory
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',

  // ── Java / Kotlin / Android ──
  'target',        // Maven
  '.gradle',       // Gradle cache
  '.idea',         // IntelliJ IDEA

  // ── C# / .NET ──
  // NOTE: 'bin' removed - too generic, could be user scripts directory
  'obj',
  // NOTE: 'packages' removed - too generic for modern monorepos where it often stores source code

  // ── C / C++ ──
  'cmake-build-*',
  '.ccache',

  // ── Go ──
  'vendor',

  // ── Rust ──
  // (uses 'target' — already listed under Java/Maven)

  // ── Swift / iOS ──
  '.build',        // Swift Package Manager
  'Pods',          // CocoaPods
  'DerivedData',   // Xcode
  '.swiftpm',

  // ── Cross-language build/output ──
  'dist',
  'build',
  'out',
  'coverage',
]
