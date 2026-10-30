import type { ElectronApplication } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { errorMonitor, type EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { inspectManagementProcessGroup } from './acceptance-management-process'

const now = () => new Date().toISOString()
const safeCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^(?:E[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,60})$/.test(code) ? code : 'UNAVAILABLE'
}

export function shutdownProcessSnapshot(child: ChildProcess) {
  return {
    exitCode: child.exitCode, signalCode: child.signalCode,
    stdio: Array.from({ length: Math.max(5, child.stdio.length) }, (_value, fd) => {
      const stream = child.stdio[fd] as { readableEnded?: boolean; writableFinished?: boolean; closed?: boolean; destroyed?: boolean; readableFlowing?: boolean | null } | null | undefined
      return { fd, present: !!stream, readableEnded: stream?.readableEnded ?? null, writableFinished: stream?.writableFinished ?? null, closed: stream?.closed ?? null, destroyed: stream?.destroyed ?? null, readableFlowing: stream?.readableFlowing ?? null }
    }),
  }
}

interface CloseAttempt {
  phase: string
  startedAt: string
  deadlineMs: number
  appClose: 'not-called' | 'pending' | 'resolved' | 'rejected'
  timedOut: boolean
  before: ReturnType<typeof shutdownProcessSnapshot>
  atDeadline?: ReturnType<typeof shutdownProcessSnapshot>
  after?: ReturnType<typeof shutdownProcessSnapshot>
  finishedAt?: string
  processGroup?: Awaited<ReturnType<typeof inspectManagementProcessGroup>>
}

export function observeAcceptanceShutdown(app: ElectronApplication, child: ChildProcess, profile: string) {
  const root = realpathSync(profile)
  const file = join(root, `acceptance-shutdown-${randomUUID()}.jsonl`)
  const events: Array<Record<string, unknown>> = []
  const attempts: CloseAttempt[] = []
  const removers: Array<() => void> = []
  const pending: Array<Promise<void>> = []
  let droppedEvents = 0
  let phase = 'running'
  let installed = false
  const note = (event: string, details: Record<string, unknown> = {}) => {
    if (events.length >= 200) { droppedEvents++; return }
    events.push({ at: now(), phase, event, ...details })
  }
  const listen = (emitter: EventEmitter, event: string | symbol, listener: (...args: any[]) => void) => {
    emitter.on(event, listener)
    removers.push(() => emitter.off(event, listener))
  }
  listen(child, 'exit', (code, signal) => note('child-exit', { code, signal }))
  listen(child, 'close', (code, signal) => note('child-close', { code, signal }))
  listen(child, errorMonitor, error => note('child-error', { errorCode: safeCode(error) }))
  for (const [fd, stream] of child.stdio.entries()) {
    if (!stream) continue
    for (const event of ['end', 'finish', 'close']) listen(stream, event, () => note('stdio-event', { fd, state: event }))
    listen(stream, errorMonitor, error => note('stdio-error', { fd, errorCode: safeCode(error) }))
  }
  try {
    const onAppClose = () => note('playwright-app-close')
    app.on('close', onAppClose)
    removers.push(() => app.off('close', onAppClose))
    const context = app.context()
    const onContextClose = () => note('playwright-context-close')
    context.on('close', onContextClose)
    removers.push(() => context.off('close', onContextClose))
  } catch (error) {
    for (const remove of removers.splice(0)) remove()
    throw error
  }
  const state = () => ({ version: 1, pid: child.pid ?? null, events, attempts, droppedEvents, final: shutdownProcessSnapshot(child), mainInstalled: installed, observationOnly: true })

  return {
    async installMain() {
      await app.evaluate(({ app, BrowserWindow }, { root, file }) => {
        const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
        const path = process.getBuiltinModule('node:path') as typeof import('node:path')
        if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() || path.dirname(file) !== root) throw new Error('Shutdown diagnostics require the owned profile directory')
        const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
        let count = 0
        let writeFailed = false
        const failure = () => {
          if (!writeFailed) {
            try { console.error('[AcceptanceShutdown] Passive lifecycle evidence could not be written') } catch { /* The observer cannot replace an application failure. */ }
          }
          writeFailed = true
        }
        const write = (event: string, details: Record<string, unknown> = {}) => {
          if (count++ >= 200) return
          try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n') }
          catch {
            // Observation must never interrupt the application's own quit handlers.
            failure()
          }
        }
        const windows = () => {
          const all = BrowserWindow.getAllWindows()
          return { count: all.length, items: all.slice(0, 32).map(window => ({ id: window.id, destroyed: window.isDestroyed() })), truncated: all.length > 32 }
        }
        const appEvent = (event: string, value: Electron.Event) => {
          try { write(event, { defaultPrevented: value.defaultPrevented, windows: windows(), writeFailed }) } catch { failure() }
        }
        app.on('before-quit', event => appEvent('before-quit', event))
        app.on('will-quit', event => appEvent('will-quit', event))
        app.on('quit', (event, exitCode) => { appEvent('quit', event); write('quit-code', { exitCode }) })
        const observed = new Set<number>()
        const watch = (window: Electron.BrowserWindow) => {
          if (observed.has(window.id)) return
          observed.add(window.id)
          const id = window.id
          window.on('close', event => write('window-close', { id, defaultPrevented: event.defaultPrevented }))
          window.on('closed', () => write('window-closed', { id }))
        }
        for (const window of BrowserWindow.getAllWindows()) watch(window)
        app.on('browser-window-created', (_event, window) => { try { watch(window); write('window-created', { id: window.id }) } catch { failure() } })
        process.once('exit', code => { write('process-exit', { code, writeFailed }); try { fs.closeSync(fd) } catch { failure() } })
        write('observer-installed', { windows: windows() })
      }, { root, file })
      installed = true
      note('main-observer-installed')
    },
    begin(phaseName: string, deadlineMs: number) {
      phase = phaseName
      const attempt: CloseAttempt = { phase, startedAt: now(), deadlineMs, appClose: 'not-called', timedOut: false, before: shutdownProcessSnapshot(child) }
      attempts.push(attempt)
      note('close-requested')
      return attempt
    },
    called(attempt: CloseAttempt) { attempt.appClose = 'pending' },
    settled(attempt: CloseAttempt, outcome: 'resolved' | 'rejected', error?: unknown) {
      attempt.appClose = outcome
      note(`app-close-${outcome}`, error ? { errorCode: safeCode(error) } : {})
    },
    deadline(attempt: CloseAttempt) {
      attempt.timedOut = true
      attempt.atDeadline = shutdownProcessSnapshot(child)
      note('close-deadline')
      pending.push(inspectManagementProcessGroup(child.pid).then(result => { attempt.processGroup = result }))
    },
    finish(attempt: CloseAttempt) {
      attempt.after = shutdownProcessSnapshot(child)
      attempt.finishedAt = now()
    },
    async evidence() {
      await Promise.all(pending)
      let main: Array<Record<string, unknown>> = []
      if (installed) {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Shutdown lifecycle evidence must be a small owned regular file')
        main = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (main[0]?.event !== 'observer-installed' || main[0]?.pid !== child.pid) throw new Error('Shutdown lifecycle evidence does not confirm observer installation in the owned process')
        if (main.some(event => event.writeFailed === true)) throw new Error('The passive native lifecycle observer reported a recording failure')
      }
      return { ...state(), main }
    },
    state,
    dispose() { for (const remove of removers.splice(0)) remove() },
  }
}

export type AcceptanceShutdownObserver = ReturnType<typeof observeAcceptanceShutdown>
