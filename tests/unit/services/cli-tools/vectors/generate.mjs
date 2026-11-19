// Generates the shared `halo.cli/1` package test vectors.
//
// The same files are checked by the client import (vectors.test.ts) and by
// any server that validates uploads, so both sides agree on what a valid
// package is and which error code each violation gets. Every vector breaks at
// most one rule. Output is deterministic; regenerate only when the contract
// changes, and copy the whole directory to every consumer.
//
//   node tests/unit/services/cli-tools/vectors/generate.mjs
//
// Every vector declares `platforms: ["any"]` and no `runtime.minNode`, because
// host checks (platform, runtime version) belong to the client only.

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'

const OUT = dirname(fileURLToPath(import.meta.url))
// Zip timestamps are DOS local time; a local-time constant keeps the bytes
// identical whatever the generating machine's time zone.
const MTIME = new Date(2026, 0, 1, 0, 0, 0)
const ID = 'com.example.vector'

const sha256Hex = data => createHash('sha256').update(data).digest('hex')
const bytes = value => (typeof value === 'string' ? strToU8(value) : value)

/** Integrity of payload files: `path\0sha256hex\n` lines sorted by UTF-16 code units. */
function integrityOf(payload) {
  const paths = Object.keys(payload).sort()
  const hash = createHash('sha256')
  for (const path of paths) hash.update(`${path}\0${sha256Hex(bytes(payload[path]))}\n`)
  return `sha256-${hash.digest('base64')}`
}

const TOOL_JS = "#!/usr/bin/env node\nprocess.stdout.write('vector\\n')\n"

function manifestFor(payload, overrides = {}) {
  return {
    schema: 'halo.cli/1',
    id: ID,
    version: '1.0.0',
    commands: [{ name: 'vector', entry: 'bin/tool.js' }],
    runtime: { kind: 'halo-node' },
    platforms: ['any'],
    integrity: integrityOf(payload),
    ...overrides,
  }
}

/**
 * Build a zip from an ordered list of [name, content] pairs. Names are used
 * verbatim, so unsafe names can be written on purpose.
 */
function zip(entries) {
  const files = {}
  for (const [name, content] of entries) files[name] = [bytes(content), { mtime: MTIME, level: 6 }]
  return zipSync(files, { mtime: MTIME })
}

/** A package with the given payload (paths relative to payload/) and manifest. */
function pkg(payload, { manifest, extra = [], manifestText } = {}) {
  const text = manifestText ?? JSON.stringify(manifest ?? manifestFor(payload), null, 2)
  return zip([
    ['manifest.json', text],
    ...Object.entries(payload).map(([path, content]) => [`payload/${path}`, content]),
    ...extra,
  ])
}

const basePayload = { 'bin/tool.js': TOOL_JS }
const vectors = []
const add = (file, data, expect, note) => vectors.push({ file, data, expect, note })
const ok = (payload, manifest) => ({ ok: true, id: manifest.id, version: manifest.version, integrity: integrityOf(payload) })

// ---- valid ----------------------------------------------------------------

{
  const manifest = manifestFor(basePayload)
  add('ok-minimal.hcli', pkg(basePayload, { manifest }), ok(basePayload, manifest), 'required fields only')
}
{
  // Ordering trap: U+FF21 sorts after U+1F600 by UTF-16 code units but before it by UTF-8 bytes.
  const payload = {
    'bin/tool.js': TOOL_JS,
    'bin/other': "#!/usr/bin/env node\nprocess.stdout.write('other\\n')\n",
    'lib/B.cjs': 'module.exports = 1\n',
    'lib/a.mjs': 'export default 1\n',
    'lib/ord/\uFF21.js': 'module.exports = "fullwidth"\n',
    'lib/ord/\u{1F600}.js': 'module.exports = "emoji"\n',
    'lib/readme.txt': 'MZ is only an image header for .exe and .dll files\n',
    'node_modules/dep/package.json': JSON.stringify({
      name: 'dep', version: '1.0.0', scripts: { test: 'node test.js', prepare: 'node build.js' },
      optionalDependencies: { 'some-helper': '^1.0.0' },
    }),
    'node_modules/dep/index.js': 'module.exports = 2\n',
    'package.json': 'this is not json, so it declares nothing\n',
  }
  const manifest = manifestFor(payload, {
    version: '2.1.0-rc.1+build.7',
    name: 'Vector Tool',
    description: 'Every optional field set',
    commands: [
      { name: 'vector', entry: 'bin/tool.js' },
      { name: 'vector-other', entry: 'bin/other' },
    ],
    runtime: { kind: 'halo-node' },
    platforms: ['any', 'darwin-arm64'],
    auth: { method: 'external-login' },
    nonInteractive: true,
    outputFormats: ['json', 'text'],
    sideEffects: 'writes',
    guide: 'guide/README.md',
  })
  const data = zip([
    ['manifest.json', JSON.stringify(manifest, null, 2)],
    ['payload/', ''],
    ['payload/bin/', ''],
    ...Object.entries(payload).map(([path, content]) => [`payload/${path}`, content]),
    ['guide/README.md', '# Vector tool\n'],
    ['LICENSES/dep.txt', 'MIT\n'],
  ])
  add('ok-full.hcli', data, ok(payload, manifest), 'all optional fields, directory entries, extensionless entry, UTF-16 ordering trap, benign package.json files')
}

// ---- archive and layout ---------------------------------------------------

add('package-not-zip.hcli', strToU8('this is not a zip archive\n'), { error: 'PACKAGE_INVALID' }, 'not a zip file')
add('package-extra-root.hcli', pkg(basePayload, { extra: [['README.md', 'hi\n']] }), { error: 'PACKAGE_INVALID' }, 'top-level entry outside the layout')
add('package-no-payload.hcli', zip([['manifest.json', JSON.stringify(manifestFor({}), null, 2)], ['guide/README.md', 'x\n']]), { error: 'PACKAGE_INVALID' }, 'no payload directory')
add('path-dotdot.hcli', pkg(basePayload, { extra: [['payload/../evil.js', 'x\n']] }), { error: 'PATH_UNSAFE' }, '.. segment')
add('path-absolute.hcli', pkg(basePayload, { extra: [['/payload/evil.js', 'x\n']] }), { error: 'PATH_UNSAFE' }, 'absolute entry name')
add('path-backslash.hcli', pkg(basePayload, { extra: [['payload\\evil.js', 'x\n']] }), { error: 'PATH_UNSAFE' }, 'backslash in entry name')
add('path-drive.hcli', pkg(basePayload, { extra: [['C:/payload/evil.js', 'x\n']] }), { error: 'PATH_UNSAFE' }, 'drive letter')
add('path-case-collision.hcli', pkg(basePayload, { extra: [['payload/BIN/tool.js', 'x\n']] }), { error: 'PATH_UNSAFE' }, 'case-insensitive collision')

// ---- manifest -------------------------------------------------------------

add('manifest-missing.hcli', zip(Object.entries(basePayload).map(([p, c]) => [`payload/${p}`, c])), { error: 'MANIFEST_INVALID' }, 'no manifest.json')
add('manifest-not-json.hcli', pkg(basePayload, { manifestText: '{ "schema": ' }), { error: 'MANIFEST_INVALID' }, 'manifest is not JSON')
const badManifest = (file, overrides, note, payload = basePayload) =>
  add(file, pkg(payload, { manifest: manifestFor(payload, overrides) }), { error: 'MANIFEST_INVALID' }, note)
badManifest('manifest-schema-wrong.hcli', { schema: 'halo.cli/2' }, 'unknown schema id')
badManifest('manifest-unknown-key.hcli', { homepage: 'https://example.com' }, 'unknown top-level key')
badManifest('manifest-bad-id.hcli', { id: 'Com.Example.Vector' }, 'id is not lowercase reverse-DNS')
badManifest('manifest-bad-version.hcli', { version: 'v1.0.0' }, 'version is not semver')
badManifest('manifest-no-commands.hcli', { commands: [] }, 'empty commands')
badManifest('manifest-command-halo-prefix.hcli', { commands: [{ name: 'halo-vector', entry: 'bin/tool.js' }] }, 'reserved halo- prefix')
badManifest('manifest-command-unknown-key.hcli', { commands: [{ name: 'vector', entry: 'bin/tool.js', shell: true }] }, 'unknown command key')
badManifest('manifest-command-duplicate.hcli', { commands: [{ name: 'vector', entry: 'bin/tool.js' }, { name: 'vector', entry: 'bin/tool.js' }] }, 'duplicate command name')
badManifest('manifest-entry-extension.hcli', { commands: [{ name: 'vector', entry: 'bin/tool.py' }] }, 'entry is not a JS file', { 'bin/tool.py': 'print(1)\n' })
badManifest('manifest-entry-traversal.hcli', { commands: [{ name: 'vector', entry: '../manifest.js' }] }, 'entry escapes payload')
badManifest('manifest-entry-missing.hcli', { commands: [{ name: 'vector', entry: 'bin/missing.js' }] }, 'entry is not a packaged file')
badManifest('manifest-entry-directory.hcli', { commands: [{ name: 'vector', entry: 'bin' }] }, 'entry names a directory')
badManifest('manifest-runtime-unknown.hcli', { runtime: { kind: 'python' } }, 'runtime kind outside the reserved enum')
badManifest('manifest-platform-bad.hcli', { platforms: ['darwin-ppc'] }, 'platform outside the enum')
badManifest('manifest-integrity-format.hcli', { integrity: 'sha256:abc' }, 'integrity is not SRI sha256')
badManifest('manifest-auth-bad.hcli', { auth: { method: 'password' } }, 'auth method outside the enum')
badManifest('manifest-side-effects-bad.hcli', { sideEffects: 'deletes' }, 'sideEffects outside the enum')
badManifest('manifest-guide-outside.hcli', { guide: 'payload/bin/tool.js' }, 'guide not under guide/')
badManifest('manifest-guide-missing.hcli', { guide: 'guide/missing.md' }, 'guide is not a packaged file')

add('runtime-binary.hcli', pkg(basePayload, { manifest: manifestFor(basePayload, { runtime: { kind: 'binary' } }) }), { error: 'RUNTIME_KIND_UNSUPPORTED' }, 'reserved binary runtime')

// ---- integrity ------------------------------------------------------------

add('digest-mismatch.hcli', pkg(basePayload, { manifest: manifestFor({ 'bin/tool.js': 'other content\n' }) }), { error: 'DIGEST_MISMATCH' }, 'payload differs from integrity')

// ---- pure-JS rule ---------------------------------------------------------

const native = (file, extraPayload, note) => {
  const payload = { ...basePayload, ...extraPayload }
  add(file, pkg(payload), { error: 'NATIVE_NOT_ALLOWED' }, note)
}
native('native-node-addon.hcli', { 'build/addon.node': 'not really an addon\n' }, '.node file')
native('native-binding-gyp.hcli', { 'binding.gyp': '{}\n' }, 'binding.gyp')
native('native-elf.hcli', { 'bin/helper': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]) }, 'ELF image')
native('native-macho.hcli', { 'bin/helper': new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]) }, 'Mach-O 64 image')
native('native-pe.hcli', { 'bin/helper.exe': new Uint8Array([0x4d, 0x5a, 0x90, 0]) }, 'PE image with .exe name')
native('native-java-class.hcli', { 'lib/Main.class': new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]) }, '0xcafebabe image')
native('native-install-script.hcli', { 'node_modules/dep/package.json': JSON.stringify({ name: 'dep', scripts: { postinstall: 'node build.js' } }) }, 'install script')
native('native-gypfile.hcli', { 'node_modules/dep/package.json': JSON.stringify({ name: 'dep', gypfile: true }) }, 'gypfile')
native('native-os-cpu.hcli', { 'node_modules/dep/package.json': JSON.stringify({ name: 'dep', os: ['darwin'] }) }, 'os-pinned package')
native('native-platform-optional.hcli', { 'package.json': JSON.stringify({ name: 'tool', optionalDependencies: { '@esbuild/darwin-arm64': '0.20.0' } }) }, 'per-platform optional dependency')

// ---- write ----------------------------------------------------------------

for (const name of readdirSync(OUT)) if (name.endsWith('.hcli')) rmSync(join(OUT, name))
mkdirSync(OUT, { recursive: true })
const expected = {
  schema: 'halo.cli.vectors/1',
  contract: 'halo.cli/1',
  host: { platform: 'any', note: 'vectors avoid host checks; platforms is ["any"] and minNode is unset' },
  vectors: vectors.map(({ file, data, expect, note }) => {
    writeFileSync(join(OUT, file), data)
    return { file, sha256: sha256Hex(data), note, expect }
  }),
}
writeFileSync(join(OUT, 'expected.json'), JSON.stringify(expected, null, 2) + '\n')
console.log(`wrote ${vectors.length} vectors to ${OUT}`)
