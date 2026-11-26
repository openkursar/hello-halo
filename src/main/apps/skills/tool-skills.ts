import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CliToolSkill, readCurrentToolSkills } from '../../services/cli-tools'
import type { Event } from '../../platform/event'

type ToolSkillsSnapshot = Awaited<ReturnType<typeof readCurrentToolSkills>>

type ToolFingerprints = Array<[toolId: string, fingerprint: string]>

interface Stamp {
  toolStateRevision: string
  digestOfManagedSkills: string
}

interface ToolSkillSyncDeps {
  stampPath: string
  onDidChange: Event<string>
  readSnapshot(): Promise<ToolSkillsSnapshot> | undefined
  upsert(skill: CliToolSkill): Promise<void>
  remove(toolId: string): Promise<void>
  listManagedIds(): string[]
}

const STAMP_VERSION = 1
const HEADER_BYTES = 256
const MAX_STAMP_BYTES = 1024 * 1024
const CHANGE_DELAY_MS = 100

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function readStampHeader(path: string): Promise<Stamp | undefined> {
  const handle = await open(path, 'r').catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const head = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, 0)
    const firstLine = head.subarray(0, bytesRead).toString('utf8').split('\n')[0]
    if (firstLine === 'pending') return undefined
    const stamp = JSON.parse(firstLine)
    if (stamp.version !== STAMP_VERSION) return undefined
    if (typeof stamp.toolStateRevision !== 'string' || typeof stamp.digestOfManagedSkills !== 'string') {
      throw new Error('Invalid CLI skill stamp header')
    }
    return stamp
  } finally {
    await handle.close()
  }
}

async function readFingerprints(path: string, stamp: Stamp): Promise<ToolFingerprints> {
  const handle = await open(path, 'r')
  try {
    if ((await handle.stat()).size > MAX_STAMP_BYTES) throw new Error('CLI skill stamp exceeds its size limit')
    const text = await handle.readFile('utf8')
    const body = text.slice(text.indexOf('\n') + 1)
    if (digest(body) !== stamp.digestOfManagedSkills) throw new Error('CLI skill stamp digest did not match')
    return JSON.parse(body)
  } finally {
    await handle.close()
  }
}

async function writeStamp(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

export function subscribeToolSkillSync(deps: ToolSkillSyncDeps) {
  let ready = false
  let disposed = false
  let pendingRevision: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let runningRevision: string | undefined
  let completedRevision: string | undefined

  async function reconcile(expectedRevision: string) {
    let stamp: Stamp | undefined
    try {
      stamp = await readStampHeader(deps.stampPath)
    } catch (error) {
      console.warn('[ToolSkills] Cannot read sync stamp; reconciling from managed installations', { error })
    }
    if (disposed || stamp?.toolStateRevision === expectedRevision) return
    const snapshot = await deps.readSnapshot()
    if (!snapshot || disposed) return
    if (stamp?.toolStateRevision === snapshot.revision) return
    let previous = new Map<string, string>()
    if (stamp) {
      try {
        previous = new Map(await readFingerprints(deps.stampPath, stamp))
      } catch (error) {
        console.warn('[ToolSkills] Cannot read skill fingerprints; reconciling from managed installations', { error })
      }
    }
    const next: ToolFingerprints = snapshot.skills.map(({ toolId, fingerprint }) => [toolId, fingerprint])
    const wanted = new Set(next.map(([toolId]) => toolId))
    const removed = deps.listManagedIds().filter(toolId => !wanted.has(toolId))
    const changed = snapshot.skills.filter(({ toolId, fingerprint }) => previous.get(toolId) !== fingerprint)
    if (removed.length || changed.length) {
      // A crash between a file change and the new stamp must invalidate the old fast path.
      await writeStamp(deps.stampPath, 'pending\n')
      for (const toolId of removed) {
        if (disposed) return
        await deps.remove(toolId)
      }
      for (const skill of changed) {
        if (disposed) return
        const description = await skill.describe()
        if (disposed) return
        await deps.upsert(description)
      }
    }
    if (disposed) return
    const body = JSON.stringify(next)
    const header = JSON.stringify({
      version: STAMP_VERSION, toolStateRevision: snapshot.revision, digestOfManagedSkills: digest(body),
    })
    await writeStamp(deps.stampPath, `${header}\n${body}`)
  }

  function flush(): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (running) return running
    const revision = pendingRevision
    pendingRevision = undefined
    if (!revision || disposed || revision === completedRevision) return Promise.resolve()
    runningRevision = revision
    running = reconcile(revision).then(() => {
      completedRevision = revision
    }).catch(error => {
      console.warn('[ToolSkills] Reconciliation failed; the next request or change can retry', { error })
    }).finally(() => {
      running = undefined
      runningRevision = undefined
      if (pendingRevision && !disposed) schedule()
    })
    return running
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flush(), CHANGE_DELAY_MS)
    timer.unref()
  }

  const subscription = deps.onDidChange(revision => {
    pendingRevision = revision
    if (ready) schedule()
  })
  return {
    afterPrepare(revision: string | undefined): Promise<void> | undefined {
      ready = true
      if (!running && !pendingRevision && revision === completedRevision) return undefined
      if (revision !== runningRevision) pendingRevision ??= revision
      return flush().then(() => pendingRevision ? flush() : undefined)
    },
    dispose() {
      disposed = true
      subscription.dispose()
      if (timer) clearTimeout(timer)
      return running
    },
  }
}
