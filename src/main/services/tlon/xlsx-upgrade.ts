import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { setImmediate as yieldToMain } from 'node:timers/promises'
import type { IngestHashesV1, IngestJob } from '../../../shared/types/tlon'
import { extractText } from './extract'
import { extractionRevision, isExtractionCurrent, sameTextStamp, stampOf, type TextStamp } from './extraction-revision'
import { legacyXlsxTextHash } from './legacy-xlsx'
import { getKBDir, getKBTextDir } from './paths'
import { getKB, readHashes, sha256, writeHashes } from './service'

type RecordEntry = IngestHashesV1['files'][string]
type Protection = NonNullable<RecordEntry['protection']>
interface Target {
  kind: 'missing' | 'file' | 'unsafe'
  scope: Protection['scope']
  textPath: string
  hash?: string
  stamp?: TextStamp
  directory?: { ino: number; dev: number }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function sameTarget(left: Target, right: Target): boolean {
  return left.kind === right.kind && left.scope === right.scope && left.textPath === right.textPath
    && left.hash === right.hash && left.directory?.ino === right.directory?.ino && left.directory?.dev === right.directory?.dev
    && (left.stamp && right.stamp ? sameTextStamp(left.stamp, right.stamp) : left.stamp === right.stamp)
}

async function hashText(text: string): Promise<string> {
  const hash = createHash('sha256')
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + 65536, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    hash.update(text.slice(start, end))
    start = end
    if (start < text.length) await yieldToMain()
  }
  return hash.digest('hex')
}

/** Repair old XLSX cache entries inside the existing per-KB ingest queue. */
export async function upgradeXlsxSource(job: IngestJob, textPath: string, onWritten: () => void): Promise<boolean> {
  const revision = extractionRevision(job.absolutePath)
  if (revision === undefined) return false
  if (!getKB(job.kbId) || !existsSync(getKBDir(job.kbId))) {
    console.warn(`[Tlon] XLSX upgrade skipped for a removed knowledge base: ${job.sourcePath}`)
    job.status = 'skipped'
    return true
  }
  const record = readHashes(job.kbId).files[job.sourcePath]
  if (!record || isExtractionCurrent(job.absolutePath, record)) return false
  const kbDir = getKBDir(job.kbId)
  const textDir = getKBTextDir(job.kbId)
  const targetPath = join(textDir, textPath)
  let kbIdentity: TextStamp
  let kbRealPath: string
  let sourceIdentity: TextStamp
  let sourceRealPath: string
  let buffer: Buffer
  try {
    if (!getKB(job.kbId)) throw new Error('Knowledge base was removed')
    kbIdentity = stampOf(statSync(kbDir))
    kbRealPath = realpathSync(kbDir)
    sourceIdentity = stampOf(statSync(job.absolutePath))
    sourceRealPath = realpathSync(job.absolutePath)
    buffer = readFileSync(job.absolutePath)
  } catch (error) {
    console.warn(`[Tlon] XLSX upgrade not started for ${job.sourcePath}:`, error)
    job.status = 'skipped'
    return true
  }
  const sourceHash = sha256(buffer)
  const currentSource = () => {
    try {
      const kb = getKB(job.kbId)
      const kbStat = statSync(kbDir)
      return !!kb && (!job.automatic || kb.status !== 'paused') && kbStat.ino === kbIdentity.ino && kbStat.dev === kbIdentity.dev && realpathSync(kbDir) === kbRealPath
        && realpathSync(job.absolutePath) === sourceRealPath && sameTextStamp(sourceIdentity, stampOf(statSync(job.absolutePath)))
    } catch { return false }
  }
  const deferred = (reason = 'Source or knowledge base changed or was removed') => {
    if (job.automatic && getKB(job.kbId)?.status === 'paused') reason = 'Automatic learning was paused'
    console.warn(`[Tlon] XLSX upgrade deferred for ${job.sourcePath}: ${reason}`)
    job.status = 'skipped'
    return true
  }
  const inspectTarget = async (): Promise<Target> => {
    if (record.textPath && record.textPath !== textPath) return { kind: 'unsafe', scope: 'path', textPath: record.textPath }
    let directory
    try { directory = lstatSync(textDir) } catch (error) {
      if (missing(error)) return { kind: 'missing', scope: 'text', textPath }
      throw error
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) return { kind: 'unsafe', scope: 'directory', textPath, stamp: stampOf(directory) }
    const directoryIdentity = { ino: directory.ino, dev: directory.dev }
    let stat
    try { stat = lstatSync(targetPath) } catch (error) {
      if (missing(error)) return { kind: 'missing', scope: 'text', textPath, directory: directoryIdentity }
      throw error
    }
    const stamp = stampOf(stat)
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: 'unsafe', scope: 'text', textPath, stamp, directory: directoryIdentity }
    const fd = openSync(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let transferred = false
    try {
      const parent = lstatSync(textDir)
      if (parent.isSymbolicLink() || parent.ino !== directory.ino || parent.dev !== directory.dev || !sameTextStamp(stamp, stampOf(fstatSync(fd)))) throw new Error('Extracted text changed before it could be checked')
      const stream = createReadStream(targetPath, { fd, autoClose: true })
      transferred = true
      const hash = createHash('sha256')
      for await (const chunk of stream) { hash.update(chunk); await yieldToMain() }
      if (!sameTextStamp(stamp, stampOf(lstatSync(targetPath)))) throw new Error('Extracted text changed while it was being checked')
      return { kind: 'file', scope: 'text', textPath, hash: hash.digest('hex'), stamp, directory: directoryIdentity }
    } finally {
      if (!transferred) closeSync(fd)
    }
  }
  const targetStillMatches = (target: Target) => {
    try {
      if (target.scope === 'path') return record.textPath === target.textPath
      if (target.scope === 'directory') return !!target.stamp && sameTextStamp(target.stamp, stampOf(lstatSync(textDir)))
      if (!existsSync(textDir)) return target.kind === 'missing' && !target.directory
      const directory = lstatSync(textDir)
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.ino !== target.directory?.ino || directory.dev !== target.directory?.dev) return false
      try {
        const current = stampOf(lstatSync(targetPath))
        return !!target.stamp && sameTextStamp(target.stamp, current)
      } catch (error) { return missing(error) && target.kind === 'missing' }
    } catch { return false }
  }
  const preserve = (target: Target, reason: string) => {
    if (!currentSource()) return deferred()
    if (!targetStillMatches(target)) return deferred('Text identity changed before protection could be recorded')
    const hashes = readHashes(job.kbId)
    const old = hashes.files[job.sourcePath] ?? record
    const protection: Protection = {
      revision, sourceHash, textPath: target.textPath, scope: target.scope,
      ...(target.hash ? { textHash: target.hash } : {}), ...(target.stamp ? { textStamp: target.stamp } : {}), reason,
    }
    hashes.files[job.sourcePath] = { ...old, lastError: reason, protection }
    writeHashes(job.kbId, hashes)
    const prior = old.protection
    if (!prior || prior.sourceHash !== sourceHash || prior.textHash !== target.hash || prior.textPath !== target.textPath || prior.scope !== target.scope || prior.reason !== reason) {
      console.warn('[Tlon] Preserved existing XLSX text during extractor upgrade', { kbId: job.kbId, sourcePath: job.sourcePath, sourceHash, textPath: target.textPath, textHash: target.hash, reason })
    }
    job.status = 'skipped'
    return true
  }

  if (!currentSource()) return deferred()
  const before = await inspectTarget()
  if (before.kind === 'unsafe') return preserve(before, 'Existing extracted text has an unsafe or unrecognized path and was preserved.')
  const prior = record.protection
  if (prior?.revision === revision && prior.sourceHash === sourceHash && prior.textPath === before.textPath && prior.textHash === before.hash && before.kind === 'file') {
    return preserve(before, prior.reason)
  }

  let content: string
  try { content = await extractText(job.absolutePath, buffer) } catch (error) {
    if (!currentSource()) return deferred()
    const hashes = readHashes(job.kbId)
    hashes.files[job.sourcePath] = { ...record, lastError: error instanceof Error ? error.message : String(error) }
    writeHashes(job.kbId, hashes)
    throw error
  }
  if (!currentSource()) return deferred()
  const body = content.trim() ? `<!-- source: ${job.sourcePath} -->\n\n${content}` : null
  const currentHash = body === null ? null : await hashText(body)
  const legacyHash = before.kind === 'file' && before.hash !== currentHash ? await legacyXlsxTextHash(buffer, job.sourcePath) : null
  if (!currentSource()) return deferred()
  const after = await inspectTarget()
  if (!sameTarget(before, after)) return after.kind === 'missing' ? deferred('Extracted text was removed during the upgrade') : preserve(after, 'Extracted text changed during the upgrade and was preserved.')
  if (after.kind === 'file' && after.hash !== currentHash && after.hash !== legacyHash) return preserve(after, 'Existing extracted text differs from generated output and was preserved.')
  if (!currentSource()) return deferred()
  if (!targetStillMatches(after)) return deferred('Text identity changed before commit')

  if (body !== null && after.hash !== currentHash) {
    if (!existsSync(textDir)) mkdirSync(textDir)
    const ready = await inspectTarget()
    if (!currentSource()) return deferred()
    const createdDirectory = after.kind === 'missing' && !after.directory && ready.kind === 'missing'
    if (!createdDirectory && !sameTarget(after, ready)) return ready.kind === 'missing' ? deferred('Extracted text was removed before commit') : preserve(ready, 'Extracted text changed during the upgrade and was preserved.')
    const temporary = join(textDir, `${textPath}.${randomUUID()}.tmp`)
    let temporaryIdentity: { ino: number; dev: number } | undefined
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = fstatSync(fd)
        temporaryIdentity = { ino: stat.ino, dev: stat.dev }
        writeFileSync(fd, body)
      } finally { closeSync(fd) }
      if (!currentSource()) return deferred()
      if (!targetStillMatches(ready)) {
        const changed = await inspectTarget()
        return changed.kind === 'missing' ? deferred('Extracted text was removed before replacement') : preserve(changed, 'Extracted text changed before replacement and was preserved.')
      }
      const produced = lstatSync(temporary)
      if (!temporaryIdentity || produced.isSymbolicLink() || produced.ino !== temporaryIdentity.ino || produced.dev !== temporaryIdentity.dev) return deferred('Temporary output was replaced before commit')
      renameSync(temporary, targetPath)
    } finally {
      try {
        const directory = lstatSync(textDir)
        if (directory.isSymbolicLink() || directory.ino !== ready.directory?.ino || directory.dev !== ready.directory?.dev) {
          console.warn(`[Tlon] Kept an upgrade temporary file because its directory changed: ${job.sourcePath}`)
        } else {
          const file = lstatSync(temporary)
          if (file.ino === temporaryIdentity?.ino && file.dev === temporaryIdentity.dev) rmSync(temporary)
          else console.warn(`[Tlon] Kept a replaced upgrade temporary file: ${job.sourcePath}`)
        }
      } catch (error) {
        if (!missing(error)) console.warn(`[Tlon] Could not remove the XLSX upgrade temporary file for ${job.sourcePath}:`, error)
      }
    }
  } else if (body === null && after.kind === 'file') {
    rmSync(targetPath)
  }
  if (!currentSource()) return deferred()
  const hashes = readHashes(job.kbId)
  hashes.files[job.sourcePath] = {
    hash: sourceHash, ingestedAt: new Date().toISOString(), extractorRevision: revision,
    ...(body === null ? { empty: true } : { textPath }),
  }
  writeHashes(job.kbId, hashes)
  if (body !== null) onWritten()
  job.status = body === null ? 'skipped' : 'completed'
  job.completedAt = new Date().toISOString()
  job.contentHash = sourceHash
  return true
}
