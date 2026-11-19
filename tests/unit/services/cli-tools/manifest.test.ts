import { describe, expect, it } from 'vitest'
import { CliToolError, parseCliManifest } from '../../../../src/main/services/cli-tools'
import { assertManifestSupported, isSafeRelativePath } from '../../../../src/main/services/cli-tools/manifest'
import { buildManifest } from './helpers'

const host = { platform: 'darwin', arch: 'arm64', nodeVersion: '24.21.0' }

function parse(overrides: Record<string, unknown>) {
  return parseCliManifest(JSON.stringify({ ...buildManifest({}), ...overrides }))
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof CliToolError ? err.code : 'NOT_TYPED'
  }
  return undefined
}

describe('cli-tools manifest', () => {
  it('accepts a minimal halo.cli/1 manifest', () => {
    const manifest = parse({})
    expect(manifest.id).toBe('com.example.tool')
    expect(manifest.commands).toEqual([{ name: 'tool', entry: 'bin/tool.js' }])
  })

  it('accepts every optional declaration and keeps credentials out by construction', () => {
    const manifest = parse({
      name: 'Tool', description: 'x', auth: { method: 'external-login' }, nonInteractive: true,
      outputFormats: ['json'], sideEffects: 'writes', guide: 'guide/SKILL.md',
    })
    expect(manifest.auth).toEqual({ method: 'external-login' })
    expect(codeOf(() => parse({ auth: { method: 'env-ref', token: 'x' } }))).toBe('MANIFEST_INVALID')
  })

  it.each([
    ['unknown top-level key', { extra: 1 }],
    ['wrong schema', { schema: 'halo.cli/2' }],
    ['uppercase id', { id: 'Com.Example' }],
    ['non-semver version', { version: 'v1.0' }],
    ['no commands', { commands: [] }],
    ['duplicate commands', { commands: [{ name: 'a', entry: 'a.js' }, { name: 'a', entry: 'b.js' }] }],
    ['reserved halo- prefix', { commands: [{ name: 'halo-x', entry: 'a.js' }] }],
    ['path as command name', { commands: [{ name: '../x', entry: 'a.js' }] }],
    ['escaping entry', { commands: [{ name: 'a', entry: '../a.js' }] }],
    ['absolute entry', { commands: [{ name: 'a', entry: '/a.js' }] }],
    ['backslash entry', { commands: [{ name: 'a', entry: 'bin\\a.js' }] }],
    ['non-JS entry', { commands: [{ name: 'a', entry: 'a.sh' }] }],
    ['unknown runtime kind', { runtime: { kind: 'python' } }],
    ['bad platform', { platforms: ['darwin-ppc'] }],
    ['bad integrity', { integrity: 'md5-abc' }],
    ['hex integrity', { integrity: `sha256-${'0'.repeat(64)}` }],
    ['guide outside guide/', { guide: 'payload/x.md' }],
  ])('rejects %s', (_label, overrides) => {
    expect(codeOf(() => parse(overrides))).toBe('MANIFEST_INVALID')
  })

  it('accepts extensionless entries such as npm bin scripts', () => {
    expect(parse({ commands: [{ name: 'tsc', entry: 'bin/tsc' }] }).commands[0].entry).toBe('bin/tsc')
    expect(codeOf(() => parse({ commands: [{ name: 'a', entry: 'bin/a.py' }] }))).toBe('MANIFEST_INVALID')
  })

  it('rejects text that is not JSON', () => {
    expect(codeOf(() => parseCliManifest('{'))).toBe('MANIFEST_INVALID')
  })

  it('reserves runtime kind binary without accepting it', () => {
    const manifest = parse({ runtime: { kind: 'binary' } })
    expect(codeOf(() => assertManifestSupported(manifest, host))).toBe('RUNTIME_KIND_UNSUPPORTED')
  })

  it('checks the runtime version and platform', () => {
    expect(codeOf(() => assertManifestSupported(parse({ runtime: { kind: 'halo-node', minNode: '25' } }), host)))
      .toBe('RUNTIME_VERSION_UNSUPPORTED')
    expect(codeOf(() => assertManifestSupported(parse({ runtime: { kind: 'halo-node', minNode: '24.21' } }), host)))
      .toBeUndefined()
    expect(codeOf(() => assertManifestSupported(parse({ platforms: ['win32-x64'] }), host)))
      .toBe('PLATFORM_UNSUPPORTED')
    expect(codeOf(() => assertManifestSupported(parse({ platforms: ['darwin-arm64'] }), host))).toBeUndefined()
  })

  it('defines safe relative paths', () => {
    expect(isSafeRelativePath('a/b.js')).toBe(true)
    for (const bad of ['', '/a', 'C:/a', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\0b']) {
      expect(isSafeRelativePath(bad)).toBe(false)
    }
  })
})
