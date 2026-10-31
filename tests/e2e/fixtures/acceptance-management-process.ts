import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

interface ManagedApplication {
  process(): ChildProcess
  close(): Promise<void>
}

interface ProcessSnapshot {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  closeObserved: boolean
  stdout: { ended: boolean; closed: boolean; destroyed: boolean } | null
  stderr: { ended: boolean; closed: boolean; destroyed: boolean } | null
}

interface ProcessGroupSnapshot {
  requestedAt: string
  finishedAt?: string
  scope: 'owned-posix-process-group'
  processes: Array<{ pid: number; ppid: number; comm: string }>
  truncated?: boolean
  errorCode?: string
  mayOverlapForcedCleanup: true
}

interface CloseAttempt {
  phase: string
  startedAt: string
  finishedAt?: string
  timeoutMs: number
  appClose: 'not-called' | 'pending' | 'resolved' | 'rejected'
  timedOut: boolean
  alreadyClosed?: boolean
  atTimeout?: ProcessSnapshot
  afterClose?: ProcessSnapshot
  processGroup?: ProcessGroupSnapshot
}

export interface ManagementShutdownDiagnostics {
  pid: number | null
  trackedAt: string
  events: Array<{ event: string; at: string; phase: string; code?: number | null; signal?: NodeJS.Signals | null; errorCode?: string }>
  attempts: CloseAttempt[]
}

export interface OwnedManagementApp {
  application: ManagedApplication
  // Playwright disposes the application facade on close; retain the native handle while it is available.
  child: ChildProcess
  closed: boolean
  completion: Promise<void>
  diagnostics?: ManagementShutdownDiagnostics
  diagnosticPhase?: string
}

const execute = promisify(execFile)
const now = () => new Date().toISOString()
const errorCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(code) ? code : 'UNAVAILABLE'
}

function snapshot(owned: OwnedManagementApp): ProcessSnapshot {
  const child = owned.child
  const pipe = (stream: ChildProcess['stdout']) => stream ? { ended: stream.readableEnded, closed: stream.closed, destroyed: stream.destroyed } : null
  return { exitCode: child.exitCode, signalCode: child.signalCode, closeObserved: owned.closed, stdout: pipe(child.stdout), stderr: pipe(child.stderr) }
}

function note(owned: OwnedManagementApp, event: string, details: { code?: number | null; signal?: NodeJS.Signals | null; errorCode?: string } = {}) {
  owned.diagnostics?.events.push({ event, at: now(), phase: owned.diagnosticPhase ?? 'running', ...details })
}

export async function inspectManagementProcessGroup(pid: number | undefined): Promise<ProcessGroupSnapshot> {
  const result: ProcessGroupSnapshot = { requestedAt: now(), scope: 'owned-posix-process-group', processes: [], mayOverlapForcedCleanup: true }
  try {
    if (process.platform === 'win32') { result.errorCode = 'POSIX_GROUP_UNAVAILABLE'; return result }
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) { result.errorCode = 'PID_UNAVAILABLE'; return result }
    let identifiers: string[]
    try {
      const listed = await execute('pgrep', ['-g', String(pid)], { timeout: 500, maxBuffer: 16384 })
      const matched = listed.stdout.split(/\s+/).filter(value => /^\d+$/.test(value))
      result.truncated = matched.length > 128
      identifiers = matched.slice(0, 128)
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return result
      throw error
    }
    if (!identifiers.length) return result
    const listed = await execute('ps', ['-p', identifiers.join(','), '-o', 'pid=,ppid=,pgid=,comm='], { timeout: 500, maxBuffer: 65536 })
    for (const line of listed.stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      if (match && Number(match[3]) === pid) result.processes.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[4].slice(0, 200) })
    }
  } catch (error) { result.errorCode = errorCode(error) }
  finally { result.finishedAt = now() }
  return result
}

export function trackManagementApp(application: ManagedApplication, diagnoseShutdown = false): OwnedManagementApp {
  const child = application.process()
  const owned: OwnedManagementApp = { application, child, closed: false, completion: Promise.resolve() }
  if (diagnoseShutdown) {
    owned.diagnostics = { pid: child.pid ?? null, trackedAt: now(), events: [], attempts: [] }
    child.once('exit', (code, signal) => note(owned, 'child-exit', { code, signal }))
    for (const [name, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      pipe?.once('end', () => note(owned, `${name}-end`))
      pipe?.once('close', () => note(owned, `${name}-close`))
    }
  }
  owned.completion = new Promise<void>(resolve => {
    child.once('close', (code, signal) => {
      owned.closed = true
      note(owned, 'child-close', { code, signal })
      resolve()
    })
  })
  return owned
}

async function within(completion: Promise<unknown>, timeoutMs: number, message: string, onTimeout?: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new Error(message)) }, timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function closeManagementApp(owned: OwnedManagementApp, timeoutMs = 15000, phase = 'close') {
  const attempt: CloseAttempt | undefined = owned.diagnostics ? { phase, startedAt: now(), timeoutMs, appClose: 'not-called', timedOut: false } : undefined
  let group: Promise<ProcessGroupSnapshot> | undefined
  if (attempt) {
    owned.diagnosticPhase = phase
    owned.diagnostics!.attempts.push(attempt)
    note(owned, 'close-requested')
  }
  if (owned.closed) {
    if (attempt) { attempt.alreadyClosed = true; attempt.afterClose = snapshot(owned); attempt.finishedAt = now() }
    return
  }
  try {
    if (attempt) attempt.appClose = 'pending'
    let closing: Promise<void>
    try { closing = owned.application.close() }
    catch (error) { if (attempt) attempt.appClose = 'rejected'; note(owned, 'app-close-rejected', { errorCode: errorCode(error) }); throw error }
    if (attempt) closing = closing.then(() => { attempt.appClose = 'resolved'; note(owned, 'app-close-resolved') }, error => {
      attempt.appClose = 'rejected'; note(owned, 'app-close-rejected', { errorCode: errorCode(error) }); throw error
    })
    await within(Promise.all([closing, owned.completion]), timeoutMs, 'Management acceptance application did not close within its deadline', () => {
      if (!attempt) return
      attempt.timedOut = true
      attempt.atTimeout = snapshot(owned)
      note(owned, 'close-deadline')
      // Capture asynchronously so diagnostics never postpone the existing forced cleanup.
      group = inspectManagementProcessGroup(owned.child.pid)
    })
  } catch (error) {
    try {
      if (!owned.closed) {
        const child = owned.child
        if (!child.pid) throw new Error('The owned management application has no process identity')
        note(owned, 'forced-cleanup-requested')
        try {
          if (process.platform === 'win32') {
            await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 })
          } else {
            // Playwright launches each POSIX application as its own process-group leader.
            process.kill(-child.pid, 'SIGKILL')
          }
        } catch (killError) {
          if (!owned.closed && (killError as NodeJS.ErrnoException).code !== 'ESRCH') throw killError
        }
        await within(owned.completion, 5000, 'The owned management application did not exit after forced shutdown')
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Management application shutdown and owned-process cleanup both failed')
    }
    throw error
  } finally {
    if (attempt) {
      attempt.afterClose = snapshot(owned)
      if (group) attempt.processGroup = await group
      attempt.finishedAt = now()
    }
  }
}
