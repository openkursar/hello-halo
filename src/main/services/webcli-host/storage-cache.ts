import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getHaloDir } from '../../foundation/config.service'
import { encodeForStorage, tryDecodeFromStorage } from '../../foundation/crypto-envelope'
import { fail } from './protocol'

interface Entry { value: string; updatedAt: number }
interface Cache { version: 1; entries: Record<string, Entry> }
interface StorageScope { adapter: string; origin: string; key: string }
const MAX_VALUE_BYTES = 64000
const MAX_ENTRIES = 64
const MAX_FILE_BYTES = 16 * 1024 * 1024
const pending = new Map<string, Promise<unknown>>()
let fileQueue: Promise<unknown> = Promise.resolve()

async function transaction<T>(file: string, operation: (cache: Cache) => T, write: boolean): Promise<T> {
  const task = fileQueue.catch(() => {}).then(async () => {
    let cache: Cache = { version: 1, entries: {} }
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error('Cache exceeds limit')
      const bytes = await readFile(file)
      if (bytes.length > MAX_FILE_BYTES) throw new Error('Cache exceeds limit')
      cache = JSON.parse(bytes.toString('utf8'))
      if (cache?.version !== 1 || !cache.entries || typeof cache.entries !== 'object' || Array.isArray(cache.entries)
        || Object.keys(cache.entries).length > MAX_ENTRIES
        || Object.entries(cache.entries).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key)
          || typeof value?.value !== 'string' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) throw new Error('Invalid cache')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('HOST_STORAGE_CACHE_UNAVAILABLE', 'Stored browser credentials could not be read; the cache was preserved.')
    }
    const result = operation(cache)
    if (write) {
      const entries = Object.entries(cache.entries).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_ENTRIES)
      const data = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) })
      if (Buffer.byteLength(data) > MAX_FILE_BYTES) return fail('HOST_STORAGE_CACHE_UNAVAILABLE', 'Stored browser credentials exceed the cache limit.')
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
        await rename(temporary, file)
      } catch {
        return fail('HOST_STORAGE_CACHE_UNAVAILABLE', 'Browser credentials could not be saved.')
      } finally { await unlink(temporary).catch(() => {}) }
    }
    return result
  })
  fileQueue = task.catch(() => {})
  return task
}

export async function sessionStorageValue(scope: StorageScope, options: { forceRefresh?: boolean; cacheOnly?: boolean },
  signal: AbortSignal, readLive: () => Promise<{ value: string | null }>): Promise<{ value: string | null }> {
  const file = join(getHaloDir(), 'webcli', 'session-storage.json')
  const key = createHash('sha256').update(JSON.stringify([scope.adapter, scope.origin, scope.key])).digest('hex')
  const operationKey = `${file}\0${key}`
  if (!pending.has(operationKey) && pending.size >= MAX_ENTRIES) return fail('HOST_BUSY', 'Too many storage operations are pending.')
  const task = (pending.get(operationKey) || Promise.resolve()).catch(() => {}).then(async () => {
    signal.throwIfAborted()
    const cached = await transaction(file, cache => {
      const previous = cache.entries[key]
      if (options.forceRefresh) delete cache.entries[key]
      return options.forceRefresh ? undefined : previous
    }, options.forceRefresh === true)
    signal.throwIfAborted()
    if (cached) {
      const decoded = tryDecodeFromStorage(cached.value)
      if (!decoded.ok) return fail('HOST_STORAGE_CACHE_UNAVAILABLE', 'Stored browser credentials could not be decoded; request a fresh login.')
      if (Buffer.byteLength(decoded.value) > MAX_VALUE_BYTES) return fail('HOST_PAYLOAD_TOO_LARGE', 'Storage value exceeds the size limit.')
      return { value: decoded.value }
    }
    if (options.cacheOnly) return fail('PAGE_CONTEXT_REQUIRED', 'No cached session storage is available; prepare the login page first.')
    const result = await readLive()
    signal.throwIfAborted()
    if (result.value !== null && (typeof result.value !== 'string' || Buffer.byteLength(result.value) > MAX_VALUE_BYTES)) return fail('HOST_PAYLOAD_TOO_LARGE', 'Storage value exceeds the size limit.')
    if (result.value) {
      const value = encodeForStorage(result.value)
      await transaction(file, cache => {
        signal.throwIfAborted()
        const updatedAt = Math.max(Date.now(), ...Object.values(cache.entries).map(entry => entry.updatedAt + 1))
        if (!Number.isSafeInteger(updatedAt)) return fail('HOST_STORAGE_CACHE_UNAVAILABLE', 'Stored browser credential metadata is invalid.')
        delete cache.entries[key]
        cache.entries[key] = { value, updatedAt }
      }, true)
    }
    signal.throwIfAborted()
    return result
  })
  pending.set(operationKey, task)
  try { return await task } finally { if (pending.get(operationKey) === task) pending.delete(operationKey) }
}
