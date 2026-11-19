import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import * as tar from 'tar-stream'
import type { RuntimeArtifact, RuntimeComponent } from '../../provider'
import { RuntimeError } from '../../errors'
import { CODEX_PLATFORMS, optionalComponents, requiredComponents, type CodexPlatform } from './policy'

export const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
export const MAX_ARCHIVE_FILES = 64

export function archiveEntryPath(name: string, platform: CodexPlatform): string {
  if (name.length > 512 || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(part => part === '.' || part === '..') || !name.startsWith('package/')) throw new RuntimeError('invalid-manifest')
  const path = name.slice(8).replace(/\/$/, '')
  const triple = CODEX_PLATFORMS[platform].triple
  const optional = optionalComponents(platform)
  const allowed = new Set(['', 'vendor', `vendor/${triple}`, `vendor/${triple}/codex`, `vendor/${triple}/path`, 'package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'NOTICE', 'THIRD-PARTY-NOTICES', ...requiredComponents(platform), ...optional, ...optional.map(dirname)])
  if (!allowed.has(path)) throw new RuntimeError('invalid-manifest')
  return path
}

export async function materializeCodex(artifact: RuntimeArtifact, archivePath: string, directory: string, signal: AbortSignal): Promise<{ executable: string; components: RuntimeComponent[] }> {
  if (!(artifact.platform in CODEX_PLATFORMS)) throw new RuntimeError('unsupported-platform')
  const platform = artifact.platform as CodexPlatform
  const digest = createHash('sha512')
  for await (const chunk of createReadStream(archivePath, { signal })) digest.update(chunk)
  if (!artifact.integrity || `sha512-${digest.digest('base64')}` !== artifact.integrity) throw new RuntimeError('checksum-mismatch')
  const extractor = tar.extract()
  const seen = new Set<string>()
  const components: RuntimeComponent[] = []
  let expanded = 0
  let count = 0
  const deadline = AbortSignal.timeout(60_000)
  const extraction = new AbortController()
  const operationSignal = AbortSignal.any([signal, deadline, extraction.signal])
  const entryWork = new Set<Promise<void>>()
  const entryStreams = new Set<{ destroy(error?: Error): unknown }>()
  extractor.on('error', error => {
    extraction.abort(error)
    for (const stream of entryStreams) stream.destroy(error)
  })
  extractor.on('entry', (header, stream, next) => {
    entryStreams.add(stream)
    stream.once('close', () => entryStreams.delete(stream))
    stream.on('error', error => extractor.destroy(error))
    const work = (async () => {
      if (operationSignal.aborted) throw new RuntimeError('cancelled')
      const path = archiveEntryPath(header.name, platform)
      if (++count > MAX_ARCHIVE_FILES || seen.has(path.toLowerCase()) || !['file', 'directory'].includes(header.type || 'file') || header.linkname) throw new RuntimeError('invalid-manifest')
      seen.add(path.toLowerCase())
      if (!Number.isSafeInteger(header.size) || header.size! < 0 || header.size! > 512 * 1024 * 1024 || (expanded += header.size!) > MAX_EXPANDED_BYTES) throw new RuntimeError('invalid-manifest')
      const destination = join(directory, path)
      if (header.type === 'directory') {
        if (header.size !== 0 || path.includes('.')) throw new RuntimeError('invalid-manifest')
        await mkdir(destination, { recursive: true })
        stream.resume()
      } else {
        if (!path || !path.includes('/') && !['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'NOTICE', 'THIRD-PARTY-NOTICES'].includes(path)) throw new RuntimeError('invalid-manifest')
        await mkdir(dirname(destination), { recursive: true })
        const hash = createHash('sha256')
        let size = 0
        stream.on('data', chunk => {
          if (!(chunk instanceof Uint8Array)) { stream.destroy(new RuntimeError('invalid-manifest')); return }
          hash.update(chunk)
          size += chunk.byteLength
        })
        await pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: [...requiredComponents(platform), ...optionalComponents(platform)].includes(path) ? 0o755 : 0o644 }), { signal: operationSignal })
        if (size !== header.size) throw new RuntimeError('invalid-manifest')
        components.push({ path, checksum: hash.digest('hex'), size })
      }
      next()
    })().catch(error => { extractor.destroy(error as Error) }).finally(() => { entryWork.delete(work) })
    entryWork.add(work)
  })
  let unpackedBytes = 0
  const expandedLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      unpackedBytes += chunk.byteLength
      if (unpackedBytes > MAX_EXPANDED_BYTES + 1024 * 1024) callback(new RuntimeError('invalid-manifest'))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(createReadStream(archivePath), createGunzip(), expandedLimit, extractor, { signal: operationSignal })
  } catch (cause) {
    if (signal.aborted) throw new RuntimeError('cancelled', { cause })
    if (deadline.aborted) throw new RuntimeError('source-timeout', { cause })
    if (cause instanceof RuntimeError) throw cause
    throw new RuntimeError('invalid-manifest', { cause })
  } finally {
    extraction.abort()
    for (const stream of entryStreams) stream.destroy()
    await Promise.allSettled([...entryWork])
  }
  for (const path of requiredComponents(platform)) {
    if (!components.some(component => component.path === path) || !(await stat(join(directory, path))).isFile()) throw new RuntimeError('invalid-manifest')
  }
  const manifestFile = components.find(component => component.path === 'package.json')
  if (!manifestFile || manifestFile.size > 128 * 1024) throw new RuntimeError('invalid-manifest')
  let manifest
  try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) } catch { throw new RuntimeError('invalid-manifest') }
  const target = CODEX_PLATFORMS[platform]
  if (manifest.name !== '@openai/codex' || manifest.version !== artifact.payloadVersion || manifest.os?.length !== 1 || manifest.os[0] !== target.os || manifest.cpu?.length !== 1 || manifest.cpu[0] !== target.cpu) throw new RuntimeError('invalid-manifest')
  return { executable: requiredComponents(platform)[0], components }
}
