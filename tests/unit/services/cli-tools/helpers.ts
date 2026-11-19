/**
 * Builders for `.hcli` test packages. Packages are assembled in memory and
 * zipped with the same library the store uses to read them.
 */

import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { strToU8, zipSync } from 'fflate'

export type Files = Record<string, string | Uint8Array>

/** Same canonical listing as payload.ts, computed independently from memory. */
export function integrityOfFiles(payload: Files): string {
  const lines = Object.keys(payload).sort().map(path => {
    const data = payload[path]
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
    return `${path}\0${createHash('sha256').update(bytes).digest('hex')}\n`
  })
  return `sha256-${createHash('sha256').update(lines.join('')).digest('base64')}`
}

export interface PackageSpec {
  id?: string
  version?: string
  commands?: Array<{ name: string; entry: string }>
  payload?: Files
  manifest?: Record<string, unknown>
  /** Extra raw archive entries (bypass layout helpers). */
  extra?: Files
  /** Override the computed integrity. */
  integrity?: string
}

export function defaultPayload(version: string, message = 'hello'): Files {
  return {
    'bin/tool.js': `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`${message} ${version}`)})\n`,
    'package.json': JSON.stringify({ name: 'tool', version }),
  }
}

export function buildManifest(spec: PackageSpec): Record<string, unknown> {
  const version = spec.version ?? '1.0.0'
  const payload = spec.payload ?? defaultPayload(version)
  return {
    schema: 'halo.cli/1',
    id: spec.id ?? 'com.example.tool',
    version,
    commands: spec.commands ?? [{ name: 'tool', entry: 'bin/tool.js' }],
    runtime: { kind: 'halo-node', minNode: '22.14' },
    platforms: ['any'],
    integrity: spec.integrity ?? integrityOfFiles(payload),
    ...spec.manifest,
  }
}

export function writePackage(dir: string, spec: PackageSpec = {}): string {
  const version = spec.version ?? '1.0.0'
  const payload = spec.payload ?? defaultPayload(version)
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(buildManifest({ ...spec, payload }))),
  }
  for (const [path, data] of Object.entries(payload)) {
    entries[`payload/${path}`] = typeof data === 'string' ? strToU8(data) : data
  }
  for (const [path, data] of Object.entries(spec.extra ?? {})) {
    entries[path] = typeof data === 'string' ? strToU8(data) : data
  }
  const file = join(dir, `${spec.id ?? 'com.example.tool'}-${version}-${Math.random().toString(36).slice(2)}.hcli`)
  writeFileSync(file, zipSync(entries))
  return file
}

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'halo-cli-tools-test-'))
}

/** Restore write permission (installed trees are read-only) and delete. */
export function removeTree(dir: string): void {
  const unlock = (path: string): void => {
    try {
      const stat = statSync(path)
      chmodSync(path, stat.isDirectory() ? 0o755 : 0o644)
      if (stat.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name))
    } catch {
      // Already gone.
    }
  }
  unlock(dir)
  rmSync(dir, { recursive: true, force: true })
}
