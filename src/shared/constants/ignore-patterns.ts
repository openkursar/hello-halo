/**
 * Ignore patterns for file watching and scanning.
 *
 * Three layers, always stacked (not either/or):
 *
 *   1. ALWAYS_IGNORE_DIRS      C++ watcher level — zero JS overhead
 *   2. BASELINE_IGNORE_PATTERNS  JS level — always active
 *   3. .gitignore                JS level — additive, project-specific
 *
 * Duplicate rules are harmless (the `ignore` library deduplicates).
 * Sources: github/gitignore templates, each language's official .gitignore.
 */

// ─── Layer 1: C++ level ──────────────────────────────────────────────────────
// VCS and app metadata directories. Excluded via @parcel/watcher's native
// `ignore` option — events from these paths never reach JavaScript.

export const ALWAYS_IGNORE_DIRS = [
  // Version control
  '.git',
  '.hg',
  '.svn',
  'CVS',
  '.bzr',
  // App metadata
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
  'packages',      // NuGet (older projects)

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
