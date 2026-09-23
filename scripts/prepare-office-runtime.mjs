#!/usr/bin/env node

/**
 * Materialize the bundled Office library runtime.
 *
 * Installs the locked set of pure-JS packages declared in
 * office-runtime-src/package.json into resources/office-runtime/node_modules,
 * which ships as an extraResource and is exposed to agent sessions via the
 * halo-node shim + NODE_PATH (src/main/services/office-runtime/).
 *
 * Hard rule: the runtime must stay pure JS. Any .node binary in the install
 * tree fails the script — a native module would silently break the bundle on
 * every platform except the build host.
 *
 * Usage:
 *   node scripts/prepare-office-runtime.mjs           # skip when up to date
 *   node scripts/prepare-office-runtime.mjs --force   # always rebuild
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const STAGING_DIR = path.join(PROJECT_ROOT, 'office-runtime-src')
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'resources', 'office-runtime')
const STAMP_FILE = path.join(OUTPUT_DIR, '.stamp')
const FONTS_DIR = path.join(OUTPUT_DIR, 'fonts')

/**
 * Bundled fonts, pinned by release tag + sha256. Noto Sans SC ships so PDF
 * skills can embed CJK text via @pdf-lib/fontkit (SIL OFL 1.1 — its license
 * file must ship next to the font). Exposed to agent sessions through
 * HALO_OFFICE_FONTS_DIR (see services/office-runtime).
 */
const FONT_ASSETS = [
  {
    file: 'NotoSansSC-Regular.otf',
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf',
    sha256: 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9',
  },
  {
    file: 'OFL-NotoSansSC.txt',
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE',
    sha256: '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2',
  },
]

const log = (msg) => console.log(`[office-runtime] ${msg}`)
const fail = (msg) => {
  console.error(`[office-runtime] ERROR: ${msg}`)
  process.exit(1)
}

/**
 * Directory/file names that are dead weight at runtime. Pruned per-package to
 * keep the bundle small; require() never touches any of these.
 */
const PRUNE_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', 'spec', 'example', 'examples', 'demo', 'demos',
  'doc', 'docs', 'coverage', '.github', 'benchmark', 'benchmarks',
])
const PRUNE_FILE_SUFFIXES = ['.map', '.md', '.markdown', '.ts.orig']
const PRUNE_FILE_NAMES = new Set([
  '.npmignore', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc',
  '.travis.yml', '.editorconfig', 'CHANGELOG', 'HISTORY', 'AUTHORS',
])
// Keep licences: 'license'/'licence' files stay so redistribution terms ship.
const KEEP_FILE_PATTERN = /^(licen[cs]e|notice)/i

/**
 * Per-package prunes for a require()-only runtime: browser bundles, ESM
 * duplicates and legacy typings that the CJS entry never touches. Paths are
 * relative to the package root and tied to the locked versions — revisit when
 * bumping a version in office-runtime-src/package.json. The require smoke test
 * at the end of this script catches a prune that breaks an entry point.
 */
const PACKAGE_PRUNE_PATHS = {
  'pdf-lib': ['dist', 'es', 'ts3.4', 'src', 'yarn.lock'], // main: cjs/index.js
  'exceljs': ['dist'], // main: excel.js -> lib/; dist/ is browser-only bundles
  'pptxgenjs': ['dist/pptxgen.es.js', 'dist/pptxgen.bundle.js', 'dist/pptxgen.min.js'],
  'docx': ['dist/index.mjs', 'dist/index.umd.cjs'], // require path is dist/index.cjs
  // main: dist/fontkit.umd.js; ES builds, minified duplicates and the raw es/ tree are unused
  '@pdf-lib/fontkit': ['dist/fontkit.es.js', 'dist/fontkit.es.min.js', 'dist/fontkit.umd.min.js', 'es'],
  '@types': ['.'], // type packages are dev-time only
}

function walk(dir, onEntry) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (onEntry(abs, entry) === false) continue
    if (entry.isDirectory()) walk(abs, onEntry)
  }
}

function lockfileHash() {
  const lock = fs.readFileSync(path.join(STAGING_DIR, 'package-lock.json'))
  return createHash('sha256').update(lock).digest('hex')
}

function isUpToDate() {
  try {
    return fs.readFileSync(STAMP_FILE, 'utf8').trim() === lockfileHash()
  } catch {
    return false
  }
}

function installStaging() {
  log('Installing locked packages (npm ci, scripts disabled)...')
  execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', {
    cwd: STAGING_DIR,
    stdio: 'inherit',
  })
}

function assertPureJs(modulesDir) {
  const offenders = []
  walk(modulesDir, (abs, entry) => {
    if (entry.isFile() && (abs.endsWith('.node') || entry.name === 'binding.gyp')) {
      offenders.push(path.relative(modulesDir, abs))
    }
  })
  if (offenders.length > 0) {
    fail(
      `Native module artifacts found — the office runtime must be pure JS:\n  ` +
      offenders.join('\n  ')
    )
  }
}

/**
 * True when `dir` is a package root, i.e. its parent is a node_modules dir or
 * an npm scope dir directly under one. Junk-dir pruning is restricted to
 * package roots: deeper directories named "doc"/"test"/... can be real source
 * (exceljs ships its workbook code under lib/doc/).
 */
function isPackageRoot(dir) {
  const parent = path.dirname(dir)
  if (path.basename(parent) === 'node_modules') return true
  return path.basename(parent).startsWith('@') &&
    path.basename(path.dirname(parent)) === 'node_modules'
}

function prune(modulesDir) {
  let removed = 0
  const dirsToRemove = []
  walk(modulesDir, (abs, entry) => {
    const name = entry.name
    if (entry.isDirectory()) {
      // npm's .bin symlinks are absolute paths into this staging checkout;
      // copied as-is into resources/, they point outside the app bundle and
      // fail macOS codesign verification. require() never touches them.
      if (name === '.bin') {
        dirsToRemove.push(abs)
        return false
      }
      if (PRUNE_DIR_NAMES.has(name.toLowerCase()) && isPackageRoot(path.dirname(abs))) {
        dirsToRemove.push(abs)
        return false // do not descend; will be removed wholesale
      }
      return
    }
    if (KEEP_FILE_PATTERN.test(name)) return
    const lower = name.toLowerCase()
    if (
      PRUNE_FILE_SUFFIXES.some((s) => lower.endsWith(s)) ||
      PRUNE_FILE_NAMES.has(name) ||
      PRUNE_FILE_NAMES.has(name.replace(/\.(md|txt)$/i, ''))
    ) {
      fs.rmSync(abs, { force: true })
      removed++
    }
  })
  for (const dir of dirsToRemove) {
    fs.rmSync(dir, { recursive: true, force: true })
    removed++
  }
  for (const [pkg, subPaths] of Object.entries(PACKAGE_PRUNE_PATHS)) {
    for (const sub of subPaths) {
      const target = sub === '.' ? path.join(modulesDir, pkg) : path.join(modulesDir, pkg, sub)
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
        removed++
      }
    }
  }
  log(`Pruned ${removed} junk files/dirs`)
}

/**
 * require() every top-level package from the output tree with the host node.
 * Catches over-pruning and broken installs before anything ships.
 */
function smokeTest(outModules) {
  const pkg = JSON.parse(fs.readFileSync(path.join(STAGING_DIR, 'package.json'), 'utf8'))
  const names = Object.keys(pkg.dependencies ?? {})
  const script = names.map((n) => `require(${JSON.stringify(n)});`).join('') + 'console.log("ok");'
  const out = execSync(`node -e '${script}'`, {
    env: { ...process.env, NODE_PATH: outModules },
    encoding: 'utf8',
  }).trim()
  if (out !== 'ok') fail(`require smoke test produced unexpected output: ${out}`)
  log(`Smoke test passed: ${names.join(', ')}`)
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Download each pinned font unless it is already present with the right hash.
 * Independent of the npm lockfile stamp, so it runs on every invocation and
 * heals a deleted or corrupted fonts dir.
 */
async function ensureFonts() {
  fs.mkdirSync(FONTS_DIR, { recursive: true })
  for (const { file, url, sha256 } of FONT_ASSETS) {
    const dest = path.join(FONTS_DIR, file)
    if (fs.existsSync(dest) && sha256File(dest) === sha256) continue

    log(`Downloading font asset ${file}...`)
    let res
    try {
      res = await fetch(url)
    } catch (err) {
      fail(`Font download failed for ${url}: ${err?.cause?.code ?? err.message}`)
    }
    if (!res.ok) fail(`Font download failed (${res.status}) for ${url}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha256) {
      fail(`Font checksum mismatch for ${file}:\n  expected ${sha256}\n  got      ${actual}`)
    }
    fs.writeFileSync(dest, bytes)
    log(`Fetched ${file} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`)
  }
}

function dirSizeMb(dir) {
  let bytes = 0
  walk(dir, (abs, entry) => {
    if (entry.isFile()) bytes += fs.statSync(abs).size
  })
  return (bytes / 1024 / 1024).toFixed(1)
}

function writeManifest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(STAGING_DIR, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(STAGING_DIR, 'package-lock.json'), 'utf8'))
  const packages = {}
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    packages[name] = lock.packages?.[`node_modules/${name}`]?.version ?? pkg.dependencies[name]
  }
  const fonts = FONT_ASSETS.map((f) => f.file)
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'manifest.json'),
    JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), packages, fonts }, null, 2)
  )
}

async function main() {
  const force = process.argv.includes('--force')

  if (!fs.existsSync(path.join(STAGING_DIR, 'package-lock.json'))) {
    fail('office-runtime-src/package-lock.json missing — commit a lockfile first.')
  }

  await ensureFonts()

  if (!force && isUpToDate() && fs.existsSync(path.join(OUTPUT_DIR, 'node_modules'))) {
    log('Up to date (lockfile unchanged) — skipping. Use --force to rebuild.')
    return
  }

  installStaging()

  const stagedModules = path.join(STAGING_DIR, 'node_modules')
  assertPureJs(stagedModules)
  prune(stagedModules)
  // Re-check after prune: pruning must never be the reason a .node slipped by.
  assertPureJs(stagedModules)

  const outModules = path.join(OUTPUT_DIR, 'node_modules')
  fs.rmSync(outModules, { recursive: true, force: true })
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  fs.cpSync(stagedModules, outModules, { recursive: true })

  smokeTest(outModules)
  writeManifest()
  fs.writeFileSync(STAMP_FILE, lockfileHash())
  log(`Done: ${outModules} (${dirSizeMb(outModules)} MB modules + ${dirSizeMb(FONTS_DIR)} MB fonts)`)
}

await main()
