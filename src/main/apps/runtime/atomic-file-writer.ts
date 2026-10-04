/**
 * Whole-file writes that never leave a torn file behind.
 *
 * Each write lands in a temporary sibling that is then renamed over the
 * target, so a reader (or a crash) sees either the old file or the new one.
 * Writes run one at a time: content handed in while a write is in flight
 * waits, and only the newest waiting content is written. A target briefly
 * held open by another process (on Windows, antivirus or an indexer scanning
 * the file just written) refuses the rename, so a background write retries
 * that a few times before giving up.
 */

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'

const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** Pause before each retry; a target that stays refused is given up after about 1.5 s. */
const BUSY_RETRY_DELAYS_MS = [100, 400, 1000]

function pause(ms: number): Promise<void> {
  return new Promise(resolve => {
    // An exit mid-pause is fine: the target still holds the previous whole file.
    setTimeout(resolve, ms).unref?.()
  })
}

export class AtomicFileWriter {
  private writing = false
  private waiting: string | null = null
  /** Bumped by writeSync, so a write already in flight cannot land over it. */
  private generation = 0

  constructor(
    private readonly filePath: string,
    private readonly logTag: string,
  ) {}

  /** Write in the background; failures are logged. */
  write(content: string): void {
    if (this.writing) {
      this.waiting = content
      return
    }
    void this.run(content)
  }

  /** Write before returning, superseding any background write (shutdown). Throws on failure. */
  writeSync(content: string): void {
    this.waiting = null
    this.generation += 1
    const tempPath = `${this.filePath}.sync.tmp`
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(tempPath, content, 'utf8')
    renameSync(tempPath, this.filePath)
  }

  private async run(content: string): Promise<void> {
    this.writing = true
    const generation = this.generation
    const tempPath = `${this.filePath}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(tempPath, content, 'utf8')
      await this.replace(tempPath, generation)
    } catch (err) {
      console.error(`${this.logTag} Failed to persist ${this.filePath}:`, err)
    } finally {
      this.writing = false
    }
    const next = this.waiting
    if (next !== null) {
      this.waiting = null
      void this.run(next)
    }
  }

  /** Rename the temporary file over the target, unless something newer has taken its place. */
  private async replace(tempPath: string, generation: number): Promise<void> {
    let busyCode = ''
    for (let retry = 0; ; retry++) {
      if (generation !== this.generation) {
        await unlink(tempPath)
        return
      }
      // Newer content goes out next, through the same temporary file.
      if (retry > 0 && this.waiting !== null) return
      try {
        await rename(tempPath, this.filePath)
        if (retry > 0) console.warn(`${this.logTag} ${this.filePath} was held by another process (${busyCode}); replaced on retry ${retry}`)
        return
      } catch (err) {
        busyCode = (err as NodeJS.ErrnoException).code ?? ''
        if (retry >= BUSY_RETRY_DELAYS_MS.length || !BUSY_CODES.has(busyCode)) throw err
      }
      await pause(BUSY_RETRY_DELAYS_MS[retry])
    }
  }
}
